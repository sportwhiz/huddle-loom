import { useId, type CSSProperties } from "react";
import { avatarInk } from "./avatar-color";
import { UiIcon } from "./UiIcon";
import "./marker-color.css";

// A dry-erase marker set. Existing profile colors outside it show as custom.
const colors = [
  { name: "Blue", value: "#2554c7" },
  { name: "Red", value: "#d2483c" },
  { name: "Green", value: "#2f8a57" },
  { name: "Black", value: "#1f2633" },
  { name: "Purple", value: "#7b4fc9" },
  { name: "Orange", value: "#e07a1f" },
];

/** Uses the existing profile color: it never changes the color of board content. */
export function MarkerColorField({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const hint = useId();
  return (
    <fieldset className="marker-color-field" aria-describedby={hint}>
      <legend>Your marker color</legend>
      <p id={hint}>Your avatar and live cursor use this color.</p>
      <div className="marker-color-options">
        {colors.map(color => <button
          key={color.value}
          type="button"
          className="marker-color-swatch"
          aria-label={`${color.name} marker`}
          aria-pressed={value.toLowerCase() === color.value}
          title={color.name}
          style={{ "--marker-color": color.value, "--marker-ink": avatarInk(color.value) } as CSSProperties}
          onClick={() => onChange(color.value)}
        >{value.toLowerCase() === color.value && <UiIcon name="check" />}</button>)}
        <label className="marker-color-custom" title="Choose a custom color">
          <input type="color" aria-label="Custom marker color" value={value} onChange={event => onChange(event.target.value)} />
          <UiIcon name="plus" />
        </label>
      </div>
    </fieldset>
  );
}
