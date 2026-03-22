/**
 * BB Physics — Blockbench Plugin
 * Gravity simulation for animation bones.
 *
 * Right-click any folder/bone in the Outliner → "Gravity..."
 * Set direction (X/Y/Z sliders), force (Benchions), time range.
 * Click OK → two timeline markers placed, keyframes baked.
 */
(function () {
  'use strict';

  const PLUGIN_ID      = 'bb_physics';
  const PLUGIN_VERSION = '1.0.0';
  const INST_KEY       = '__bb_physics_instance__';

  // ── Singleton guard ───────────────────────────────────────────
  try { const p = globalThis?.[INST_KEY]; if (p?.cleanup) p.cleanup(); } catch (_) {}

  // ═══════════════════════════════════════════════════════════════
  // Physics helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * Rotate the default "down" gravity vector (0,-1,0)
   * by the user-provided Euler angles (degrees, XYZ order).
   */
  function computeGravityDir(rx, ry, rz) {
    const v = new THREE.Vector3(0, -1, 0);
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz),
      'XYZ'
    );
    v.applyEuler(euler);
    return { x: v.x, y: v.y, z: v.z };
  }

  /** Collect a group and ALL its Group descendants (depth-first). */
  function collectGroupChain(root) {
    const chain = [root];
    function walk(g) {
      for (const child of (g.children || [])) {
        if (child instanceof Group) { chain.push(child); walk(child); }
      }
    }
    walk(root);
    return chain;
  }

  /**
   * Simulate spring-damper gravity for ONE bone and write rotation keyframes.
   *
   * Model: bone is a rigid rod attached at its origin.
   * Gravity creates a torque; we solve the damped-spring ODE numerically.
   *
   *   θ'' + 2ζω θ' + ω² θ = ω² · target
   *
   * Each bone in a chain runs this independently in its own local space.
   * The hierarchy naturally composes the motions → chain / rope effect.
   */
  function simulateBone(anim, bone, gravDir, benchions, startTime, endTime) {
    const snapping = anim.snapping || 20;
    const dt       = 1 / snapping;
    const frames   = Math.max(1, Math.round((endTime - startTime) / dt));

    // ── Target equilibrium rotation ─────────────────────────────
    // Maps gravity direction components to bone rotation axes.
    //  · downward gravity (-Y) → +X tilt (bone droops "forward/down")
    //  · sideways gravity (+X) → +Z tilt
    //  · forward gravity (+Z) → -X tilt
    const maxAngle = 18 + (benchions - 1) * 8; // °  (18° @ b=1, 90° @ b=10)
    const targetX  = -gravDir.y * maxAngle;
    const targetZ  =  gravDir.x * maxAngle;
    const targetY  =  gravDir.z * maxAngle * 0.3; // minor twist

    // ── Spring-damper coefficients ──────────────────────────────
    // omega: stiffer (higher benchions) = snappier response
    const omega  = 2.5 + benchions * 0.75;  // rad/s  (natural frequency)
    const zeta   = 0.65;                     // damping ratio – slightly underdamped
    const omega2 = omega * omega;
    const twoZW  = 2 * zeta * omega;

    let posX = 0, velX = 0;
    let posY = 0, velY = 0;
    let posZ = 0, velZ = 0;

    // ── Ensure bone has an animator ─────────────────────────────
    if (!anim.animators[bone.uuid]) {
      anim.animators[bone.uuid] = new BoneAnimator(bone.uuid, anim, bone.name);
    }
    const animator = anim.animators[bone.uuid];

    // ── Frame loop ──────────────────────────────────────────────
    const SUB = 4; // sub-steps per frame (stability for high omega)
    const subDt = dt / SUB;

    for (let i = 0; i <= frames; i++) {
      const t = +(startTime + i * dt).toFixed(6);

      if (i > 0) {
        for (let s = 0; s < SUB; s++) {
          const aX = omega2 * (targetX - posX) - twoZW * velX;
          const aY = omega2 * (targetY - posY) - twoZW * velY;
          const aZ = omega2 * (targetZ - posZ) - twoZW * velZ;
          velX += aX * subDt;  posX += velX * subDt;
          velY += aY * subDt;  posY += velY * subDt;
          velZ += aZ * subDt;  posZ += velZ * subDt;
        }
      }

      animator.addKeyframe({
        channel      : 'rotation',
        time         : t,
        interpolation: 'linear',
        data_points  : [{ x: +posX.toFixed(5), y: +posY.toFixed(5), z: +posZ.toFixed(5) }],
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Marker helpers
  // ═══════════════════════════════════════════════════════════════

  const MARKER_COLOR = 6; // orange in Blockbench's palette

  function placeGravityMarkers(anim, rootBoneName, startTime, endTime) {
    if (!Array.isArray(anim.markers)) anim.markers = [];

    // Remove previous gravity markers for this bone
    const tag = `⬆ Gravity[${rootBoneName}]`;
    anim.markers = anim.markers.filter(m => !String(m.name || '').startsWith(tag));

    const makeMarker = (time, label) => {
      // Try the constructor first (newer BB), fall back to plain object
      try {
        return new TimelineMarker({ time, color: MARKER_COLOR, name: label });
      } catch (_) {
        return { time, color: MARKER_COLOR, name: label };
      }
    };

    anim.markers.push(makeMarker(startTime, `${tag} ▶`));
    anim.markers.push(makeMarker(endTime,   `${tag} ■`));
  }

  // ═══════════════════════════════════════════════════════════════
  // Main entry: apply gravity and bake keyframes
  // ═══════════════════════════════════════════════════════════════

  function applyGravity({ boneUuid, rotX, rotY, rotZ, benchions, startTime, endTime }) {
    const anim = Animation?.selected;
    if (!anim) { Blockbench.showQuickMessage('Select an animation first'); return; }

    const root = Group.all.find(g => g.uuid === boneUuid);
    if (!root) { Blockbench.showQuickMessage('Bone not found'); return; }

    if (endTime <= startTime) { Blockbench.showQuickMessage('End time must be after start time'); return; }

    const gravDir    = computeGravityDir(rotX, rotY, rotZ);
    const boneChain  = collectGroupChain(root);

    Undo.initEdit({ animations: [anim] });

    boneChain.forEach(bone => {
      simulateBone(anim, bone, gravDir, +benchions, +startTime, +endTime);
    });

    placeGravityMarkers(anim, root.name, +startTime, +endTime);

    Undo.finishEdit('BB Physics – Apply Gravity');
    Animator.preview();

    // Refresh timeline markers display
    try { Timeline.vue?.$forceUpdate?.(); } catch (_) {}

    Blockbench.showQuickMessage(
      `✓ Gravity applied to ${root.name}${boneChain.length > 1 ? ` + ${boneChain.length - 1} child bone(s)` : ''}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Styles
  // ═══════════════════════════════════════════════════════════════

  const STYLE_ID = 'bb_physics_style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #bb_physics_gravity_dialog .dialog_content { margin: 0; }

      #bb_physics_gravity_dialog .phys-wrap {
        padding: 0;
        font-size: 13px;
        display: flex;
        flex-direction: column;
        gap: 0;
      }

      /* ── header strip ── */
      #bb_physics_gravity_dialog .phys-header {
        background: var(--color-accent);
        color: var(--color-accent_text, #fff);
        padding: 12px 18px;
        font-size: 0.9em;
        opacity: 0.9;
      }

      /* ── content area ── */
      #bb_physics_gravity_dialog .phys-body {
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      /* ── section card ── */
      #bb_physics_gravity_dialog .phys-card {
        border: 1px solid var(--color-border);
        background: var(--color-back);
      }
      #bb_physics_gravity_dialog .phys-card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--color-border);
        font-weight: 700;
        font-size: 0.9em;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      #bb_physics_gravity_dialog .phys-card-body {
        padding: 12px 14px;
      }

      /* ── row ── */
      #bb_physics_gravity_dialog .phys-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      #bb_physics_gravity_dialog .phys-row:last-child { margin-bottom: 0; }
      #bb_physics_gravity_dialog .phys-label {
        width: 18px;
        font-weight: 700;
        text-align: center;
        font-size: 0.88em;
      }
      #bb_physics_gravity_dialog .phys-label.x { color: #e06; }
      #bb_physics_gravity_dialog .phys-label.y { color: #0b5; }
      #bb_physics_gravity_dialog .phys-label.z { color: #39f; }
      #bb_physics_gravity_dialog .phys-range { flex: 1; accent-color: var(--color-accent); }
      #bb_physics_gravity_dialog .phys-val {
        width: 46px;
        text-align: right;
        font-size: 0.85em;
        opacity: 0.8;
        font-variant-numeric: tabular-nums;
      }

      /* ── direction badge ── */
      #bb_physics_gravity_dialog .phys-dir-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: var(--color-dark);
        border: 1px solid var(--color-border);
        padding: 4px 10px;
        font-size: 0.82em;
        margin-top: 10px;
        font-variant-numeric: tabular-nums;
      }

      /* ── benchions meter ── */
      #bb_physics_gravity_dialog .phys-bench-labels {
        display: flex;
        justify-content: space-between;
        font-size: 0.75em;
        opacity: 0.55;
        margin-top: 4px;
      }

      /* ── time inputs ── */
      #bb_physics_gravity_dialog .phys-time-row {
        display: flex;
        gap: 12px;
      }
      #bb_physics_gravity_dialog .phys-time-field {
        flex: 1;
      }
      #bb_physics_gravity_dialog .phys-time-field label {
        display: block;
        font-size: 0.8em;
        opacity: 0.65;
        margin-bottom: 4px;
      }
      #bb_physics_gravity_dialog .phys-time-field input {
        width: 100%;
      }

      /* ── hint text ── */
      #bb_physics_gravity_dialog .phys-hint {
        font-size: 0.8em;
        opacity: 0.55;
        margin-top: 6px;
      }

      /* ── bone select ── */
      #bb_physics_gravity_dialog .phys-bone-select {
        width: 100%;
      }

      /* ── footer ── */
      #bb_physics_gravity_dialog .phys-footer {
        border-top: 1px solid var(--color-border);
        padding: 10px 18px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
    `.trim();
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════
  // Dialog
  // ═══════════════════════════════════════════════════════════════

  function showGravityDialog(clickedGroup) {
    ensureStyle();

    const anim    = Animation?.selected;
    const curTime = +(Number(Timeline?.time) || 0).toFixed(3);
    const animLen = +(anim?.length || 2).toFixed(3);

    new Dialog({
      id      : 'bb_physics_gravity_dialog',
      title   : '🌍 Gravity',
      width   : 480,
      buttons : [],           // custom buttons inside the template
      component: {
        data() {
          return {
            boneList  : (Group.all || []).map(g => ({ uuid: g.uuid, name: g.name })),
            boneUuid  : clickedGroup?.uuid || (Group.all[0]?.uuid ?? ''),

            rotX      : 0,
            rotY      : 0,
            rotZ      : 0,
            benchions : 1.0,

            startTime : curTime,
            endTime   : Math.min(curTime + 1.0, animLen),
          };
        },
        computed: {
          gravDir() {
            return computeGravityDir(this.rotX, this.rotY, this.rotZ);
          },
          gravLabel() {
            const d   = this.gravDir;
            const ax  = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
            const max = Math.max(ax, ay, az);
            if (max < 0.05)  return '— neutral (no pull)';
            if (ay >= max)   return d.y < 0 ? '⬇ Downward'  : '⬆ Upward';
            if (ax >= max)   return d.x < 0 ? '⬅ Leftward'  : '➡ Rightward';
            return              d.z < 0 ? '↙ Forward'  : '↗ Backward';
          },
          gravVec() {
            const d = this.gravDir;
            return `(${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)})`;
          },
          benchLabel() {
            const b = this.benchions;
            if (b < 2)  return 'Light drift';
            if (b < 4)  return 'Gentle sway';
            if (b < 6)  return 'Normal gravity';
            if (b < 8)  return 'Heavy pull';
            return              'Extreme force';
          },
          selectedBoneName() {
            const b = (Group.all || []).find(g => g.uuid === this.boneUuid);
            return b?.name ?? '—';
          },
        },
        methods: {
          confirm() {
            const { boneUuid, rotX, rotY, rotZ, benchions, startTime, endTime } = this;
            // close dialog then apply (avoids Vue teardown issues)
            try { this.$el.closest('dialog')?.__vue__?.close?.(); } catch (_) {}
            try { document.querySelector('#bb_physics_gravity_dialog')?.closest('dialog')?.close?.(); } catch(_) {}
            // BB Dialog close
            try {
              const dlgs = [...document.querySelectorAll('.dialog')];
              dlgs.forEach(d => {
                if (d.id === 'bb_physics_gravity_dialog') {
                  // dispatch Escape to close it, then apply
                }
              });
            } catch(_) {}

            applyGravity({ boneUuid, rotX, rotY, rotZ, benchions, startTime, endTime });

            // Close the dialog the BB way
            setTimeout(() => {
              try {
                const dlg = document.getElementById('bb_physics_gravity_dialog');
                if (dlg) {
                  const closeBtn = dlg.querySelector('.dialog_close_button');
                  if (closeBtn) closeBtn.click();
                }
              } catch (_) {}
            }, 0);
          },
          cancel() {
            setTimeout(() => {
              try {
                const dlg = document.getElementById('bb_physics_gravity_dialog');
                if (dlg) {
                  const closeBtn = dlg.querySelector('.dialog_close_button');
                  if (closeBtn) closeBtn.click();
                }
              } catch (_) {}
            }, 0);
          },
        },
        template: `
<div class="phys-wrap">

  <!-- header -->
  <div class="phys-header">
    Bakes rotation keyframes that simulate gravity between two timeline markers.
    All child bones inside the selected folder are affected.
  </div>

  <div class="phys-body">

    <!-- ── Bone selector ─────────────────────────────────────── -->
    <div class="phys-card">
      <div class="phys-card-head">🦴 Target Bone / Folder</div>
      <div class="phys-card-body">
        <select class="tool phys-bone-select" v-model="boneUuid">
          <option v-for="b in boneList" :key="b.uuid" :value="b.uuid">{{ b.name }}</option>
        </select>
        <div class="phys-hint">
          Gravity will be applied to <strong>{{ selectedBoneName }}</strong>
          and every bone nested inside it.
        </div>
      </div>
    </div>

    <!-- ── Gravity direction ──────────────────────────────────── -->
    <div class="phys-card">
      <div class="phys-card-head">🧭 Gravity Direction</div>
      <div class="phys-card-body">

        <div class="phys-hint" style="margin-bottom:10px;">
          Rotate the gravity vector from its default (straight down).
          Leave all sliders at 0 for normal downward gravity.
        </div>

        <div class="phys-row">
          <span class="phys-label x">X</span>
          <input class="phys-range" type="range" v-model.number="rotX" min="-180" max="180" step="1" />
          <span class="phys-val">{{ rotX }}°</span>
        </div>
        <div class="phys-row">
          <span class="phys-label y">Y</span>
          <input class="phys-range" type="range" v-model.number="rotY" min="-180" max="180" step="1" />
          <span class="phys-val">{{ rotY }}°</span>
        </div>
        <div class="phys-row">
          <span class="phys-label z">Z</span>
          <input class="phys-range" type="range" v-model.number="rotZ" min="-180" max="180" step="1" />
          <span class="phys-val">{{ rotZ }}°</span>
        </div>

        <div class="phys-dir-badge">
          <span>{{ gravLabel }}</span>
          <span style="opacity:0.45;">{{ gravVec }}</span>
        </div>

      </div>
    </div>

    <!-- ── Benchions ─────────────────────────────────────────── -->
    <div class="phys-card">
      <div class="phys-card-head">⚖ Force — Benchions</div>
      <div class="phys-card-body">
        <div class="phys-row" style="margin-bottom:2px;">
          <input class="phys-range" type="range" v-model.number="benchions" min="0.1" max="10" step="0.1" />
          <span class="phys-val" style="width:60px;">{{ benchions.toFixed(1) }} ⚖</span>
        </div>
        <div class="phys-bench-labels">
          <span>0.1 — feather</span>
          <span style="color:var(--color-accent);">{{ benchLabel }}</span>
          <span>10 — extreme</span>
        </div>
      </div>
    </div>

    <!-- ── Time range ─────────────────────────────────────────── -->
    <div class="phys-card">
      <div class="phys-card-head">⏱ Time Range (seconds)</div>
      <div class="phys-card-body">
        <div class="phys-time-row">
          <div class="phys-time-field">
            <label>⬆ Gravity starts at</label>
            <input type="number" class="tool" v-model.number="startTime" min="0" step="0.05" />
          </div>
          <div class="phys-time-field">
            <label>■ Gravity ends at</label>
            <input type="number" class="tool" v-model.number="endTime" :min="startTime + 0.05" step="0.05" />
          </div>
        </div>
        <div class="phys-hint">
          Two timeline markers will be placed at these positions.
          Keyframes are generated at the animation's snapping rate between them.
        </div>
      </div>
    </div>

  </div><!-- /phys-body -->

  <!-- ── Footer buttons ──────────────────────────────────────── -->
  <div class="phys-footer">
    <button class="tool" @click="cancel">Cancel</button>
    <button class="tool"
            @click="confirm"
            :disabled="!boneUuid || endTime <= startTime"
            style="background:var(--color-accent); color:var(--color-accent_text, #fff); font-weight:700; padding:0 18px;">
      ✓ Apply Gravity
    </button>
  </div>

</div>
        `,
      },
    }).show();
  }

  // ═══════════════════════════════════════════════════════════════
  // Hook into Group right-click context menu
  // ═══════════════════════════════════════════════════════════════

  let _gravityAction = null;
  let _menuBarAction = null;

  function buildGravityAction() {
    _gravityAction = new Action('bb_physics_gravity_action', {
      name       : 'Gravity…',
      icon       : 'south',
      description: 'Add gravity physics simulation to this bone and its children',
      condition  : () => !!(Animation?.selected),
      click() {
        // When called from right-click, Group.selected should be set
        const clicked =
          (Array.isArray(selected) ? selected.find(s => s instanceof Group) : null)
          ?? (selected instanceof Group ? selected : null)
          ?? Group.all[0]
          ?? null;
        showGravityDialog(clicked);
      },
    });
  }

  function hookGroupMenu() {
    if (!_gravityAction) buildGravityAction();

    // Primary: Group prototype menu (Blockbench 4.x)
    try {
      if (Group.prototype?.menu?.addAction) {
        Group.prototype.menu.addAction(_gravityAction, 'physics');
        return true;
      }
    } catch (_) {}

    // Fallback: Outliner context menu (some builds)
    try {
      if (typeof Outliner !== 'undefined' && Outliner.control_menu?.addAction) {
        Outliner.control_menu.addAction(_gravityAction);
        return true;
      }
    } catch (_) {}

    return false;
  }

  function unhookGroupMenu() {
    if (!_gravityAction) return;
    try { Group.prototype?.menu?.removeAction?.(_gravityAction); } catch (_) {}
    try { Outliner?.control_menu?.removeAction?.(_gravityAction); } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════

  function cleanup() {
    unhookGroupMenu();
    try { _gravityAction?.delete(); }  catch (_) {}
    try { _menuBarAction?.delete(); }  catch (_) {}
    try { document.getElementById(STYLE_ID)?.remove(); } catch (_) {}
    _gravityAction = null;
    _menuBarAction = null;
  }

  try { globalThis[INST_KEY] = { cleanup }; } catch (_) {}

  // ═══════════════════════════════════════════════════════════════
  // Plugin registration
  // ═══════════════════════════════════════════════════════════════

  Plugin.register(PLUGIN_ID, {
    title      : 'BB Physics',
    author     : 'Community',
    description: 'Gravity physics simulation for Blockbench animations. '
               + 'Right-click any bone/folder in the Outliner → Gravity…',
    icon       : 'south',
    version    : PLUGIN_VERSION,
    min_version: '4.8.0',
    variant    : 'both',

    onload() {
      cleanup();
      buildGravityAction();

      // Hook into right-click menu
      hookGroupMenu();

      // Animation menu fallback (always visible)
      _menuBarAction = new Action('bb_physics_open_from_menu', {
        name       : 'Add Gravity to Bone…',
        icon       : 'south',
        description: 'Open the gravity physics dialog for the selected bone',
        condition  : () => !!(Animation?.selected),
        click() {
          const bone =
            (Array.isArray(selected) ? selected.find(s => s instanceof Group) : null)
            ?? (selected instanceof Group ? selected : null)
            ?? Group.all[0]
            ?? null;
          showGravityDialog(bone);
        },
      });

      MenuBar.addAction(_menuBarAction, 'animation');
    },

    onunload: cleanup,
  });

})();