import { useId, type CSSProperties } from "react";
import { avatarInk } from "./avatar-color";
import { UiIcon } from "./UiIcon";
import "./thread-color.css";

const colors = [
  { name: "Indigo", value: "#3d4a73" },
  { name: "Moss", value: "#5f7350" },
  { name: "Saffron", value: "#e3b455" },
  { name: "Clay", value: "#c47b62" },
  { name: "Lavender", value: "#9a8ab7" },
  { name: "Rose", value: "#c77b91" },
];

/** Uses the existing profile color: it never changes the color of board content. */
export function ThreadColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const hint = useId();
  return (
    <fieldset className="thread-color-field" aria-describedby={hint}>
      <legend>Your thread color</legend>
      <p id={hint}>Your color for avatars and live cursors.</p>
      <div className="thread-color-options">
        {colors.map(color => <button
          key={color.value}
          type="button"
          className="thread-color-swatch"
          aria-label={`${color.name} thread color`}
          aria-pressed={value.toLowerCase() === color.value}
          title={color.name}
          style={{ "--thread-color": color.value, "--thread-ink": avatarInk(color.value) } as CSSProperties}
          onClick={() => onChange(color.value)}
        >{value.toLowerCase() === color.value && <UiIcon name="check" />}</button>)}
        <label className="thread-color-custom" title="Choose a custom thread color">
          <input type="color" aria-label="Custom thread color" value={value} onChange={event => onChange(event.target.value)} />
          <UiIcon name="plus" />
        </label>
      </div>
    </fieldset>
  );
}
