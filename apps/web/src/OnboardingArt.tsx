import { useId } from "react";
import { ThemedImage } from "./ThemedImage";
import "./onboarding-art.css";

export type OnboardingArtKind =
  | "welcome"
  | "notes"
  | "connect"
  | "organize"
  | "collaborate"
  | "assistant"
  | "security";

/** Lightweight, theme-aware illustrations built from the product's own objects. */
export function OnboardingArt({
  kind = "notes",
}: {
  kind?: OnboardingArtKind;
}) {
  const id = useId().replaceAll(":", "");
  if (kind === "collaborate") return <div className="welcome-art welcome-art-huddle" aria-hidden="true"><ThemedImage light="/brand/huddle.webp" dark="/brand/huddle-dark.webp" alt="" width="1254" height="1254" decoding="async" /></div>;
  const note = (
    x: number,
    y: number,
    color: string,
    lines: string[],
    rotation = 0,
  ) => (
    <g transform={`rotate(${rotation} ${x + 48} ${y + 45})`}>
      <rect
        className={`welcome-note ${color}`}
        x={x}
        y={y}
        width="96"
        height="90"
        rx="3"
      />
      <path d={`M${x + 76} ${y + 90}h20v-20Z`} fill="#000" opacity=".055" />
      <text
        className="welcome-note-text"
        x={x + 48}
        y={y + (lines.length > 1 ? 38 : 48)}
        textAnchor="middle"
      >
        {lines.map((line, index) => (
          <tspan key={line} x={x + 48} dy={index ? 19 : 0}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
  return (
    <div className={`welcome-art welcome-art-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 480 280" fill="none">
        <defs>
          <pattern
            id={`${id}-dots`}
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="2" cy="2" r=".8" className="welcome-dot" />
          </pattern>
          <marker
            id={`${id}-arrow`}
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="4"
            orient="auto"
          >
            <path d="m2 1 4 3-4 3" className="welcome-arrow" />
          </marker>
        </defs>
        <rect width="480" height="280" fill={`url(#${id}-dots)`} />
        {kind === "welcome" ? (
          <>
            <marker
              id={`${id}-marker-head`}
              markerWidth="10"
              markerHeight="10"
              refX="7"
              refY="5"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="m2 1.5 5 3.5-5 3.5" className="welcome-marker-head" />
            </marker>
            <rect className="welcome-whiteboard" x="58" y="26" width="364" height="200" rx="10" />
            {note(84, 58, "yellow", ["What if…"], -4)}
            {note(192, 112, "lavender", ["Try it", "together"], 2)}
            {note(306, 52, "green", ["Next steps"], 4)}
            <path
              className="welcome-marker-stroke"
              d="M181 92C215 94 160 157 187 157"
              markerEnd={`url(#${id}-marker-head)`}
            />
            <path
              className="welcome-marker-stroke"
              d="M291 158C331 160 353 177 353 150"
              markerEnd={`url(#${id}-marker-head)`}
            />
            <ellipse
              className="welcome-marker-circle"
              cx="354"
              cy="97"
              rx="66"
              ry="59"
              transform="rotate(-8 354 97)"
            />
            <rect className="welcome-tray" x="150" y="226" width="180" height="9" rx="4.5" />
            <rect className="welcome-pen blue" x="168" y="218" width="30" height="8" rx="4" />
            <rect className="welcome-pen red" x="206" y="218" width="30" height="8" rx="4" />
            <rect className="welcome-pen green" x="244" y="218" width="30" height="8" rx="4" />
          </>
        ) : kind === "organize" ? (
          <>
            <rect
              className="welcome-panel"
              x="40"
              y="35"
              width="170"
              height="210"
              rx="12"
            />
            <path d="M59 58h15l5 5h24v21H59Z" fill="#d9be78" />
            <text className="welcome-text strong" x="60" y="110">
              Design sprint
            </text>
            <text className="welcome-text muted" x="60" y="135">
              3 boards · Your workbook
            </text>
            {["Ideas & opportunities", "Research", "Next steps"].map(
              (label, index) => (
                <g key={label}>
                  <rect
                    className={
                      index === 0 ? "welcome-selected" : "welcome-subtle"
                    }
                    x="52"
                    y={150 + index * 27}
                    width="145"
                    height="24"
                    rx="5"
                  />
                  <text
                    className="welcome-text small"
                    x="62"
                    y={166 + index * 27}
                  >
                    {label}
                  </text>
                </g>
              ),
            )}
            {note(250, 50, "yellow", ["Ideas to", "explore"], -5)}
            {note(335, 118, "pink", ["What did", "we learn?"], 5)}
            {note(245, 156, "green", ["Next steps"], -3)}
          </>
        ) : kind === "security" ? (
          <>
            <rect
              className="welcome-panel"
              x="73"
              y="32"
              width="334"
              height="217"
              rx="15"
            />
            <circle className="welcome-selected" cx="114" cy="74" r="20" />
            <path
              d="M109 73v-4a5 5 0 0 1 10 0v4m-13 0h16v12h-16Z"
              className="welcome-accent-stroke"
            />
            <text className="welcome-text strong" x="148" y="70">
              Your sign-in options
            </text>
            <text className="welcome-text muted" x="148" y="91">
              An extra layer of protection
            </text>
            <path className="welcome-rule" d="M95 113h290" />
            <text className="welcome-text" x="100" y="144">
              Passkey
            </text>
            <rect
              className="welcome-success"
              x="302"
              y="128"
              width="81"
              height="23"
              rx="11.5"
            />
            <text
              className="welcome-success-ink"
              x="342"
              y="143"
              textAnchor="middle"
            >
              Your device
            </text>
            <text className="welcome-text" x="100" y="183">
              Authenticator app
            </text>
            <circle className="welcome-success" cx="368" cy="178" r="12" />
            <path
              d="M363 175h2m4 0h2m-8 5h2m4 0h2"
              stroke="#29644c"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path className="welcome-rule" d="M95 206h290" />
            <text className="welcome-text muted small" x="100" y="230">
              Choose the method that works for you.
            </text>
          </>
        ) : (
          <>
            <path
              className="welcome-connector"
              d="M146 117h34q14 0 14 14v19h10"
              markerEnd={`url(#${id}-arrow)`}
            />
            <path
              className="welcome-connector"
              d="M305 157h22q15 0 15-15V94h14"
              markerEnd={`url(#${id}-arrow)`}
            />
            {note(
              49,
              71,
              "yellow",
              kind === "assistant" ? ["Request", "received"] : ["What if…"],
              -5,
            )}
            {note(
              208,
              119,
              "lavender",
              kind === "assistant"
                ? ["Find a", "solution"]
                : ["Try this", "together"],
              0,
            )}
            {note(
              359,
              48,
              "green",
              kind === "assistant" ? ["Follow up"] : ["Next steps"],
              5,
            )}
            {kind === "connect" && (
              <>
                <circle
                  className="welcome-selection"
                  cx="308"
                  cy="161"
                  r="11"
                />
                <path
                  d="M303 161h10m-5-5v10"
                  stroke="white"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </>
            )}
            {kind === "assistant" ? (
              <g>
                <rect
                  className="welcome-panel"
                  x="77"
                  y="235"
                  width="326"
                  height="30"
                  rx="15"
                />
                <path
                  d="m97 243 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"
                  className="welcome-accent-fill"
                />
                <text className="welcome-text small" x="113" y="254">
                  Map out a customer support workflow
                </text>
              </g>
            ) : (
              <g>
                <path
                  className="welcome-accent-fill"
                  d="m304 202 7 21 5-7 9-3Z"
                />
                <rect
                  className="welcome-selection"
                  x="319"
                  y="222"
                  width="46"
                  height="24"
                  rx="7"
                />
                <text
                  x="342"
                  y="238"
                  textAnchor="middle"
                  fill="white"
                  fontSize="11"
                  fontWeight="600"
                >
                  You
                </text>
              </g>
            )}
            {kind === "notes" && (
              <g>
                <rect
                  className="welcome-panel"
                  x="14"
                  y="76"
                  width="30"
                  height="142"
                  rx="10"
                />
                <path className="welcome-icon" d="m23 92 13 9-7 1-3 7Z" />
                <rect
                  className="welcome-note yellow"
                  x="22"
                  y="122"
                  width="14"
                  height="14"
                  rx="2"
                />
                <rect
                  className="welcome-icon"
                  x="22"
                  y="155"
                  width="14"
                  height="12"
                  rx="2"
                />
                <path className="welcome-icon" d="M23 194h13m-4-4 4 4-4 4" />
              </g>
            )}
          </>
        )}
      </svg>
    </div>
  );
}

/** Board snapshots on a timeline, with a marker arrow back to an earlier one. */
export function HistoryArt() {
  const id = useId().replaceAll(":", "");
  const snapshot = (x: number, notes: string[]) => (
    <g key={x}>
      <rect className="welcome-whiteboard history-snapshot" x={x} y="22" width="64" height="40" rx="5" />
      {notes.map((color, index) => (
        <rect key={color + index} className={`welcome-note ${color}`} x={x + 9 + index * 17} y={33 + (index % 2) * 6} width="12" height="12" rx="1.5" />
      ))}
      <circle className="history-tick" cx={x + 32} cy="76" r="3.5" />
    </g>
  );
  return (
    <svg viewBox="0 0 320 88" fill="none">
      <defs>
        <marker id={`${id}-head`} markerWidth="10" markerHeight="10" refX="6" refY="5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="m2 1.5 5 3.5-5 3.5" className="welcome-marker-head" />
        </marker>
      </defs>
      <path className="history-line" d="M28 76h264" />
      {snapshot(44, ["yellow"])}
      {snapshot(128, ["yellow", "green"])}
      {snapshot(212, ["yellow", "green", "pink"])}
      <path className="welcome-marker-stroke" d="M246 18C214 4 120 2 88 15" markerEnd={`url(#${id}-head)`} />
    </svg>
  );
}
