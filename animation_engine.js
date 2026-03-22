/**
 * IK Attachment — Blockbench Plugin
 * Constraint-based bone attachment system with keyframe baking.
 *
 * How it works:
 *   1. Define that bone A ("slave") follows bone B ("master") with a captured offset.
 *   2. Add Attach / Detach events at specific timeline positions.
 *   3. Live preview shows the constraint during animation playback.
 *   4. "Bake" writes real position/rotation keyframes to the slave bone.
 */
(function () {
  'use strict';

  const PLUGIN_ID      = 'ik_attachment';
  const PLUGIN_VERSION = '0.2.0';
  const DATA_KEY       = '__ik_attachment__';
  const INST_KEY       = '__ik_attachment_plugin_instance__';

  // ============================================================
  // Singleton guard — safe reload / hot-reload
  // ============================================================
  try {
    const prev = globalThis?.[INST_KEY];
    if (prev?.cleanup) prev.cleanup();
  } catch (_) {}

  // ============================================================
  // Per-animation data model
  // ============================================================
  //
  //  anim[DATA_KEY] = {
  //    constraints: {
  //      [slaveBoneUuid]: {
  //        masterBoneUuid : string,
  //        slaveName      : string,
  //        masterName     : string,
  //        offsetMatrix   : number[16]   // slave-in-master-local space (Matrix4 elements)
  //      }
  //    },
  //    events: {
  //      [slaveBoneUuid]: Array<{ time: number, attached: boolean }>
  //    }
  //  }

  function getAnimData(anim) {
    if (!anim) return null;
    if (!anim[DATA_KEY]) {
      anim[DATA_KEY] = { constraints: {}, events: {} };
    }
    return anim[DATA_KEY];
  }

  /**
   * Returns whether the constraint for slaveBoneUuid is active at `time`.
   * If no events are defined the constraint is always active.
   */
  function isConstraintActive(anim, slaveUuid, time) {
    const data = getAnimData(anim);
    if (!data?.constraints?.[slaveUuid]) return false;
    const evs = [...(data.events?.[slaveUuid] ?? [])].sort((a, b) => a.time - b.time);
    if (!evs.length) return true;        // always on — no toggles yet
    let state = true;
    for (const ev of evs) {
      if (ev.time <= time + 1e-5) state = ev.attached;
      else break;
    }
    return state;
  }

  // ============================================================
  // Small helpers
  // ============================================================

  const getAnim   = ()  => { try { return Animation?.selected ?? null; } catch (_) { return null; } };
  const getTimeSec = () => { try { return Number(Timeline?.time) || 0; } catch (_) { return 0; }   };
  const getGroup  = (uuid) => Group.all.find(g => g.uuid === uuid) ?? null;

  function getWorldMat(group) {
    if (!group?.mesh) return new THREE.Matrix4();
    group.mesh.updateWorldMatrix(true, false);
    return group.mesh.matrixWorld.clone();
  }

  function getParentInvWorldMat(group) {
    if (group?.parent instanceof Group && group.parent.mesh) {
      group.parent.mesh.updateWorldMatrix(true, false);
      return group.parent.mesh.matrixWorld.clone().invert();
    }
    return new THREE.Matrix4(); // identity → world = local
  }

  // ============================================================
  // Offset capture
  //   offset = master^-1 × slave  (slave expressed in master's local space)
  // ============================================================
  function captureOffset(slaveGroup, masterGroup) {
    const masterInv = getWorldMat(masterGroup).invert();
    const offset    = masterInv.multiply(getWorldMat(slaveGroup));
    return Array.from(offset.elements);
  }

  // ============================================================
  // Apply constraint to the slave mesh in the Three.js scene
  // ============================================================

  // Track which slaves had matrixAutoUpdate disabled so we can restore them.
  const _autoUpdateDisabled = new Set();

  function applyConstraintToMesh(slaveGroup, masterGroup, offsetElements) {
    if (!slaveGroup?.mesh || !masterGroup?.mesh) return;

    masterGroup.mesh.updateWorldMatrix(true, false);
    const masterWorld = masterGroup.mesh.matrixWorld.clone();

    const offsetMat = new THREE.Matrix4();
    offsetMat.elements.set(offsetElements);

    // target world = master × offset
    const targetWorld = masterWorld.multiply(offsetMat);

    // convert to slave parent-local space
    const localMat = getParentInvWorldMat(slaveGroup).multiply(targetWorld);

    slaveGroup.mesh.matrixAutoUpdate = false;
    _autoUpdateDisabled.add(slaveGroup.uuid);

    slaveGroup.mesh.matrix.copy(localMat);
    localMat.decompose(
      slaveGroup.mesh.position,
      slaveGroup.mesh.quaternion,
      slaveGroup.mesh.scale
    );
    slaveGroup.mesh.updateWorldMatrix(false, true);
  }

  function releaseConstraintOnMesh(slaveGroup) {
    if (!slaveGroup?.mesh) return;
    slaveGroup.mesh.matrixAutoUpdate = true;
    _autoUpdateDisabled.delete(slaveGroup.uuid);
  }

  // ============================================================
  // Render-frame hook — live preview of constraints
  // ============================================================

  let _prevActiveSet = new Set();

  function onRenderFrame() {
    const anim = getAnim();
    const data = anim ? getAnimData(anim) : null;

    if (!anim || !data?.constraints || !Animator?.open) {
      // Release everything
      _prevActiveSet.forEach(uuid => {
        const g = getGroup(uuid);
        if (g) releaseConstraintOnMesh(g);
      });
      _prevActiveSet.clear();
      return;
    }

    const time      = getTimeSec();
    const nowActive = new Set();

    for (const [slaveUuid, constraint] of Object.entries(data.constraints)) {
      if (!isConstraintActive(anim, slaveUuid, time)) {
        // Was active last frame → release
        if (_prevActiveSet.has(slaveUuid)) {
          const g = getGroup(slaveUuid);
          if (g) releaseConstraintOnMesh(g);
        }
        continue;
      }

      nowActive.add(slaveUuid);
      const slave  = getGroup(slaveUuid);
      const master = getGroup(constraint.masterBoneUuid);
      if (slave && master) {
        applyConstraintToMesh(slave, master, constraint.offsetMatrix);
      }
    }

    // Release constraints that were active but no longer are
    for (const uuid of _prevActiveSet) {
      if (!nowActive.has(uuid)) {
        const g = getGroup(uuid);
        if (g) releaseConstraintOnMesh(g);
      }
    }

    _prevActiveSet = nowActive;
  }

  // ============================================================
  // Bake constraints → position + rotation keyframes
  // ============================================================

  function bakeConstraints(anim) {
    if (!anim) { Blockbench.showQuickMessage('No animation selected'); return; }

    const data = getAnimData(anim);
    if (!data || !Object.keys(data.constraints).length) {
      Blockbench.showQuickMessage('No constraints to bake');
      return;
    }

    const snapping  = anim.snapping || 20;
    const duration  = anim.length   || 1;
    const step      = 1 / snapping;
    const frames    = Math.round(duration / step);

    const origTime  = Timeline.time;
    const collected = {}; // { slaveUuid: [{time, pos:[x,y,z], rot:[x,y,z]}] }

    // ── sampling loop ────────────────────────────────────────
    for (const [slaveUuid, constraint] of Object.entries(data.constraints)) {
      const slave  = getGroup(slaveUuid);
      const master = getGroup(constraint.masterBoneUuid);
      if (!slave || !master) continue;

      collected[slaveUuid] = [];

      for (let i = 0; i <= frames; i++) {
        const time = Math.round(i * step * 10000) / 10000;
        if (!isConstraintActive(anim, slaveUuid, time)) continue;

        // Seek & update scene
        Timeline.time = time;
        Animator.preview();

        // Compute constrained local matrix (same math as applyConstraintToMesh)
        master.mesh.updateWorldMatrix(true, false);
        const masterWorld = master.mesh.matrixWorld.clone();

        const offsetMat = new THREE.Matrix4();
        offsetMat.elements.set(constraint.offsetMatrix);

        const targetWorld = masterWorld.multiply(offsetMat);
        const localMat    = getParentInvWorldMat(slave).multiply(targetWorld);

        const localPos  = new THREE.Vector3();
        const localQuat = new THREE.Quaternion();
        const localScl  = new THREE.Vector3();
        localMat.decompose(localPos, localQuat, localScl);

        // Euler ZYX — matches Blockbench/Bedrock rotation convention
        const euler = new THREE.Euler().setFromQuaternion(localQuat, 'ZYX');

        // ── coordinate conversion ─────────────────────────────
        // In Blockbench (4.x), 1 BB unit = 1 Three.js unit.
        // Three.js local position of a bone = bone.origin + keyframe_position_offset
        // → keyframe_pos = localPos - bone.origin
        const kfPos = [
          localPos.x - slave.origin[0],
          localPos.y - slave.origin[1],
          localPos.z - slave.origin[2],
        ];
        const kfRot = [
          THREE.MathUtils.radToDeg(euler.x),
          THREE.MathUtils.radToDeg(euler.y),
          THREE.MathUtils.radToDeg(euler.z),
        ];

        collected[slaveUuid].push({ time, pos: kfPos, rot: kfRot });
      }
    }

    // Restore original time
    Timeline.time = origTime;
    Animator.preview();

    // ── write keyframes ──────────────────────────────────────
    let totalKf = 0;
    Undo.initEdit({ animations: [anim] });

    for (const [slaveUuid, framelist] of Object.entries(collected)) {
      if (!framelist.length) continue;

      // Ensure bone animator exists
      if (!anim.animators[slaveUuid]) {
        const g = getGroup(slaveUuid);
        if (!g) continue;
        anim.animators[slaveUuid] = new BoneAnimator(slaveUuid, anim, g.name);
      }

      const animator = anim.animators[slaveUuid];
      if (!animator) continue;

      for (const f of framelist) {
        animator.addKeyframe({
          channel      : 'position',
          time         : f.time,
          interpolation: 'linear',
          data_points  : [{ x: f.pos[0], y: f.pos[1], z: f.pos[2] }],
        });
        animator.addKeyframe({
          channel      : 'rotation',
          time         : f.time,
          interpolation: 'linear',
          data_points  : [{ x: f.rot[0], y: f.rot[1], z: f.rot[2] }],
        });
        totalKf++;
      }
    }

    Undo.finishEdit('Bake IK Attachments');
    Animator.preview();
    Blockbench.showQuickMessage(`✓ Baked ${totalKf} keyframe pairs`);
  }

  // ============================================================
  // Persistence — save/load constraint data with the project
  // ============================================================

  function onProjectSave() {
    try {
      if (!Project) return;
      const store = {};
      (Animation.all || []).forEach(anim => {
        const d = anim[DATA_KEY];
        if (!d) return;
        const hasData =
          Object.keys(d.constraints || {}).length ||
          Object.keys(d.events || {}).length;
        if (hasData) store[anim.uuid] = d;
      });
      if (!Project.meta) Project.meta = {};
      Project.meta[DATA_KEY] = store;
    } catch (_) {}
  }

  function onProjectLoad() {
    try {
      const store = Project?.meta?.[DATA_KEY];
      if (!store) return;
      (Animation.all || []).forEach(anim => {
        const saved = store[anim.uuid];
        if (saved) anim[DATA_KEY] = saved;
      });
    } catch (_) {}
  }

  // ============================================================
  // Panel dialog (Vue-based)
  // ============================================================

  let _dialog = null;

  // CSS injected once
  const STYLE_ID = 'ik_attachment_style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = s.textContent = '';
    s.id = STYLE_ID;
    s.textContent = `
      #ik_attachment_dialog .dialog_content { margin: 0; }
      #ik_attachment_dialog .ika-wrap { padding: 16px 18px; font-size: 13px; }
      #ik_attachment_dialog .ika-section {
        border: 1px solid var(--color-border);
        background: var(--color-back);
        margin-bottom: 14px;
      }
      #ik_attachment_dialog .ika-section-head {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 12px;
        border-bottom: 1px solid var(--color-border);
        font-weight: 700;
      }
      #ik_attachment_dialog .ika-section-body { padding: 10px 12px; }
      #ik_attachment_dialog .ika-row {
        display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
      }
      #ik_attachment_dialog .ika-row label { flex: 0 0 90px; opacity: 0.8; }
      #ik_attachment_dialog .ika-row select { flex: 1; }
      #ik_attachment_dialog .ika-hint { font-size: 0.82em; opacity: 0.6; margin-bottom: 10px; }
      #ik_attachment_dialog .ika-btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
      #ik_attachment_dialog .ika-event-list { margin-top: 6px; }
      #ik_attachment_dialog .ika-event-item {
        display: flex; align-items: center; font-size: 0.83em;
        margin-bottom: 3px; gap: 8px;
      }
      #ik_attachment_dialog .ika-event-time { width: 60px; opacity: 0.75; }
      #ik_attachment_dialog .ika-attach-label  { color: var(--color-accent); }
      #ik_attachment_dialog .ika-detach-label  { color: #e77; }
      #ik_attachment_dialog .ika-spacer { flex: 1; }
      #ik_attachment_dialog .ika-footer { border-top: 1px solid var(--color-border); padding-top: 12px; margin-top: 4px; }
      #ik_attachment_dialog .ika-bake-btn { width: 100%; padding: 9px 0; font-size: 1em; font-weight: 700; }
      #ik_attachment_dialog .ika-empty { opacity: 0.6; text-align: center; padding: 18px 0; }
    `.trim();
    document.head.appendChild(s);
  }

  function showPanel() {
    ensureStyle();
    if (_dialog) { try { _dialog.show(); return; } catch (_) { _dialog = null; } }

    _dialog = new Dialog({
      id     : 'ik_attachment_dialog',
      title  : '🔗 IK Attachment',
      width  : 520,
      buttons: [],
      component: {
        data() {
          return this.buildState();
        },
        methods: {
          buildState() {
            const anim = getAnim();
            const d    = anim ? getAnimData(anim) : null;
            return {
              hasAnim     : !!anim,
              animName    : anim?.name ?? '',
              constraints : d ? { ...d.constraints }                         : {},
              events      : d ? Object.fromEntries(
                              Object.entries(d.events ?? {}).map(([k, v]) => [k, [...v]])
                            ) : {},
              boneList    : (Group.all || []).map(g => ({ uuid: g.uuid, name: g.name })),
              newSlave    : '',
              newMaster   : '',
              curTime     : getTimeSec(),
            };
          },

          refresh() {
            const s = this.buildState();
            Object.assign(this.$data, s);
          },

          // ── Add constraint ─────────────────────────────────
          addConstraint() {
            const { newSlave, newMaster } = this;
            if (!newSlave || !newMaster) {
              Blockbench.showQuickMessage('Select both slave and master bones'); return;
            }
            if (newSlave === newMaster) {
              Blockbench.showQuickMessage('Slave and master must be different'); return;
            }
            const anim = getAnim();
            if (!anim) return;
            const sg = getGroup(newSlave);
            const mg = getGroup(newMaster);
            if (!sg || !mg) { Blockbench.showQuickMessage('Bone not found'); return; }

            const data = getAnimData(anim);
            data.constraints[newSlave] = {
              masterBoneUuid: newMaster,
              slaveName     : sg.name,
              masterName    : mg.name,
              offsetMatrix  : captureOffset(sg, mg),
            };
            if (!data.events[newSlave]) data.events[newSlave] = [];

            this.refresh();
            Blockbench.showQuickMessage(`✓ ${sg.name} → ${mg.name}`);
          },

          // ── Remove constraint ──────────────────────────────
          removeConstraint(uuid) {
            const anim = getAnim();
            if (!anim) return;
            const data = getAnimData(anim);
            const g = getGroup(uuid);
            if (g) releaseConstraintOnMesh(g);
            delete data.constraints[uuid];
            delete data.events[uuid];
            this.refresh();
          },

          // ── Re-capture offset at current timeline position ─
          recapture(uuid) {
            const anim = getAnim();
            if (!anim) return;
            const data = getAnimData(anim);
            const c  = data.constraints[uuid];
            const sg = c && getGroup(uuid);
            const mg = c && getGroup(c.masterBoneUuid);
            if (sg && mg) {
              c.offsetMatrix = captureOffset(sg, mg);
              Blockbench.showQuickMessage('✓ Offset recaptured');
            }
          },

          // ── Add attach / detach event ──────────────────────
          addEvent(uuid, attached) {
            const anim = getAnim();
            if (!anim) return;
            const data = getAnimData(anim);
            const time = getTimeSec();
            const evs  = (data.events[uuid] || []).filter(e => Math.abs(e.time - time) > 1e-5);
            evs.push({ time, attached });
            evs.sort((a, b) => a.time - b.time);
            data.events[uuid] = evs;
            this.refresh();
          },

          // ── Remove a single event ──────────────────────────
          removeEvent(uuid, time) {
            const anim = getAnim();
            if (!anim) return;
            const data = getAnimData(anim);
            data.events[uuid] = (data.events[uuid] || []).filter(e => Math.abs(e.time - time) > 1e-5);
            this.refresh();
          },

          // ── Clear all events for a constraint ──────────────
          clearEvents(uuid) {
            const anim = getAnim();
            if (!anim) return;
            getAnimData(anim).events[uuid] = [];
            this.refresh();
          },

          // ── Bake ───────────────────────────────────────────
          doBake() { bakeConstraints(getAnim()); },

          eventsFor(uuid) {
            return [...(this.events[uuid] ?? [])].sort((a, b) => a.time - b.time);
          },
        },

        computed: {
          constraintList() {
            return Object.entries(this.constraints).map(([uuid, c]) => ({
              uuid,
              slaveName : c.slaveName  ?? uuid,
              masterName: c.masterName ?? c.masterBoneUuid,
            }));
          },
        },

        mounted() {
          this._t = setInterval(() => {
            const t    = getTimeSec();
            const name = getAnim()?.name ?? '';
            if (t !== this.curTime) this.curTime = t;
            if (name !== this.animName) this.refresh();
          }, 100);
        },

        beforeDestroy() { clearInterval(this._t); },

        template: `
<div class="ika-wrap">

  <div v-if="!hasAnim" class="ika-empty">
    Open the Animate tab and select an animation.
  </div>

  <template v-else>

    <!-- animation label -->
    <div style="margin-bottom:12px; opacity:0.65; font-size:0.9em;">
      Animation: <strong>{{ animName }}</strong>
    </div>

    <!-- ── Add constraint ─────────────────────────────────── -->
    <div class="ika-section">
      <div class="ika-section-head">➕ Add Constraint</div>
      <div class="ika-section-body">
        <div class="ika-row">
          <label>Slave bone</label>
          <select v-model="newSlave" class="tool">
            <option value="">— select —</option>
            <option v-for="b in boneList" :key="b.uuid" :value="b.uuid">{{ b.name }}</option>
          </select>
        </div>
        <div class="ika-row">
          <label>Follows</label>
          <select v-model="newMaster" class="tool">
            <option value="">— select —</option>
            <option v-for="b in boneList" :key="b.uuid" :value="b.uuid">{{ b.name }}</option>
          </select>
        </div>
        <div class="ika-hint">
          Seek the timeline to the moment where the relative position looks correct,
          then click below to capture the offset.
        </div>
        <button class="tool" @click="addConstraint" :disabled="!newSlave || !newMaster">
          🔗 Add Constraint (capture offset now)
        </button>
      </div>
    </div>

    <!-- ── Empty state ────────────────────────────────────── -->
    <div v-if="!constraintList.length" class="ika-empty">
      No constraints defined for this animation.
    </div>

    <!-- ── Constraint cards ───────────────────────────────── -->
    <div v-for="c in constraintList" :key="c.uuid" class="ika-section">

      <div class="ika-section-head">
        <span>{{ c.slaveName }}</span>
        <span style="opacity:0.5; font-weight:400;">→</span>
        <span>{{ c.masterName }}</span>
        <div class="ika-spacer"></div>
        <button class="tool" title="Re-capture offset at current timeline position"
                @click="recapture(c.uuid)">📐 Re-capture</button>
        <button class="tool" style="margin-left:4px;"
                @click="removeConstraint(c.uuid)">🗑</button>
      </div>

      <div class="ika-section-body">
        <div class="ika-hint">Current time: {{ curTime.toFixed(3) }}s</div>

        <div class="ika-btn-row">
          <button class="tool" @click="addEvent(c.uuid, true)">
            🔗 Attach @ {{ curTime.toFixed(3) }}s
          </button>
          <button class="tool" @click="addEvent(c.uuid, false)">
            ✂️ Detach @ {{ curTime.toFixed(3) }}s
          </button>
          <button class="tool" @click="clearEvents(c.uuid)">🧹 Clear</button>
        </div>

        <!-- event list -->
        <div v-if="eventsFor(c.uuid).length" class="ika-event-list">
          <div style="font-size:0.82em; opacity:0.55; margin-bottom:4px;">Timeline events:</div>
          <div v-for="ev in eventsFor(c.uuid)" :key="ev.time" class="ika-event-item">
            <span class="ika-event-time">{{ ev.time.toFixed(3) }}s</span>
            <span :class="ev.attached ? 'ika-attach-label' : 'ika-detach-label'">
              {{ ev.attached ? '🔗 Attach' : '✂️ Detach' }}
            </span>
            <div class="ika-spacer"></div>
            <button class="tool" style="padding:1px 7px; font-size:0.8em;"
                    @click="removeEvent(c.uuid, ev.time)">✕</button>
          </div>
        </div>
        <div v-else class="ika-hint" style="margin-bottom:0;">
          No events → constraint is always active for the full animation.
        </div>
      </div>
    </div>

    <!-- ── Bake ──────────────────────────────────────────── -->
    <div v-if="constraintList.length" class="ika-footer">
      <button class="tool ika-bake-btn" @click="doBake">
        ⚙️ Bake Attachments → Keyframes
      </button>
      <div class="ika-hint" style="margin-top:8px; margin-bottom:0;">
        Writes linear position/rotation keyframes to the slave bone for every constrained frame
        (at the animation's snapping rate). Constraints are <em>not</em> removed after baking —
        delete them manually when you are done.
      </div>
    </div>

  </template>
</div>
        `,
      },
    });

    _dialog.show();
  }

  // ============================================================
  // Cleanup
  // ============================================================

  let _actions = [];

  function cleanup() {
    try { Blockbench.removeListener('render_frame', onRenderFrame); }  catch (_) {}
    try { Blockbench.removeListener('save_project',  onProjectSave); }  catch (_) {}
    try { Blockbench.removeListener('select_project', onProjectLoad); } catch (_) {}

    _autoUpdateDisabled.forEach(uuid => {
      const g = getGroup(uuid);
      if (g) releaseConstraintOnMesh(g);
    });
    _autoUpdateDisabled.clear();
    _prevActiveSet.clear();

    _actions.forEach(a => { try { a?.delete(); } catch (_) {} });
    _actions = [];

    try { _dialog?.hide(); } catch (_) {}
    _dialog = null;

    try { document.getElementById(STYLE_ID)?.remove(); } catch (_) {}
  }

  try { globalThis[INST_KEY] = { cleanup }; } catch (_) {}

  // ============================================================
  // Plugin registration
  // ============================================================

  Plugin.register(PLUGIN_ID, {
    title      : 'IK Attachment',
    author     : 'Community',
    description: 'Attach bones to each other during animation with toggleable constraints. '
               + 'Preview live, then bake to position/rotation keyframes.',
    icon       : 'link',
    version    : PLUGIN_VERSION,
    min_version: '4.8.0',
    variant    : 'both',

    onload() {
      cleanup(); // defensive double-load guard

      Blockbench.on('render_frame',  onRenderFrame);
      Blockbench.on('save_project',  onProjectSave);
      Blockbench.on('select_project', onProjectLoad);

      const panelAction = new Action('ik_attachment_open', {
        name       : 'IK Attachment Panel',
        description: 'Open the IK Attachment constraint panel',
        icon       : 'link',
        click      : showPanel,
      });

      const bakeAction = new Action('ik_attachment_bake', {
        name       : 'Bake IK Attachments',
        description: 'Convert active attachment constraints to position/rotation keyframes',
        icon       : 'archive',
        condition  : () => !!getAnim(),
        click      : () => bakeConstraints(getAnim()),
      });

      _actions = [panelAction, bakeAction];
      MenuBar.addAction(panelAction, 'animation');
      MenuBar.addAction(bakeAction,  'animation');
    },

    onunload: cleanup,
  });

})();