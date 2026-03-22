# IK Attachment — Blockbench Plugin

> **Constraint-based bone attachment system with live preview and keyframe baking.**

Attach any bone to any other bone during animation, toggle the connection on/off at specific timeline points, and convert everything to real keyframes when you're done.

---

## Use cases

| Scenario | Slave bone | Master bone |
|---|---|---|
| Character drops a held weapon | `weapon` | `right_hand` |
| Prop passed from one hand to the other | `item` | `left_hand` → `right_hand` |
| Bag hanging from a bone until thrown | `bag` | `back_bone` |
| Vehicle rider dismounts mid-animation | `rider` | `seat_bone` |
| Any two separate bones that need to move together for part of an animation | — | — |

---

## How it works

The plugin stores a **constraint** (an offset matrix captured at a specific pose) on the animation. During playback it overrides the slave bone's Three.js mesh transform so it follows the master bone in real time. No existing keyframes are touched. When you are satisfied, **baking** writes actual `position` and `rotation` keyframes to the slave bone at the animation's snapping rate.

---

## Workflow

### 1 — Open the panel

`Animation → IK Attachment Panel`

### 2 — Add a constraint

1. Select the **Slave bone** (the one that should follow).
2. Select the **Master bone** (the one to follow).
3. Seek the timeline to the frame where the relative alignment looks correct.
4. Click **Add Constraint (capture offset now)**.

The plugin captures the current spatial relationship between the two bones and stores it as the fixed offset for the constraint.

### 3 — Toggle attach / detach

With the panel open, scrub the timeline to the moment you want the bone to detach (or re-attach) and click:

- **🔗 Attach @ Xs** — bone starts following the master from this point.
- **✂️ Detach @ Xs** — bone becomes independent from this point.

Events are sorted automatically and displayed in the panel. A constraint with no events is **always active** for the full animation.

### 4 — Preview

Hit play (or scrub the timeline). The slave bone will follow the master in the viewport — no baking needed for preview.

### 5 — Bake

Click **⚙️ Bake Attachments → Keyframes**.

The plugin samples every frame in the animation (at the animation's snapping rate), computes the correct `position` and `rotation` values for the slave bone, and writes them as **linear keyframes**. The result is a clean, standalone animation that requires no plugin to play back.

> Constraints are **not removed** after baking. Delete them from the panel when you're done or keep them for further iteration.

---

## Tips

- **Re-capture offset** (📐 button) — if you change the master bone's rest pose, re-capture at the new correct alignment frame.
- **Clear events** — removes all attach/detach toggles; the constraint becomes always-active again.
- You can have multiple constraints per animation (e.g., two items in two hands).
- Constraints are **saved with the project** via `Project.meta`, so they survive save/load cycles.
- The plugin only affects the **Animate** workspace preview; it does not modify the model's geometry.

---

## Installation

### From a local file

1. Open Blockbench.
2. Go to **File → Plugins → Load plugin from file…**
3. Select `animation_ik_attachment.js`.

### From the Blockbench Plugin Store *(if published)*

Search for **IK Attachment** in **File → Plugins**.

---

## Technical notes

### Coordinate system

Blockbench 4.x uses 1:1 mapping between Blockbench units and Three.js units (1 pixel = 1 Three.js unit). The baking step converts local Three.js positions to keyframe values using:

```
keyframe_pos[i] = local_matrix_position[i] - bone.origin[i]
keyframe_rot    = Euler ZYX (degrees) from local quaternion
```

### Persistence

Constraint data is stored in `animation[DATA_KEY]` (in memory) and serialised into `Project.meta` on project save, so it survives `.bbmodel` save/load cycles.

### Undo support

Baking is wrapped in `Undo.initEdit` / `Undo.finishEdit`, so it is fully undoable with Ctrl+Z.

---

## Limitations

- Baking produces **linear** keyframes. If you need easing, apply it manually after baking (or use the *Animation Sliders* plugin).
- Very long animations baked at high snapping rates (e.g., 60 fps, 10 s) will produce many keyframes. You may want to simplify/reduce them afterwards.
- Constraints are stored in memory on the animation object; they do not export to `.geo.json` or `.animation.json` — only the baked keyframes are exported.
- Scale keyframes are not handled; the plugin only manages position and rotation.

---

## License

MIT — free to use, modify, and distribute.