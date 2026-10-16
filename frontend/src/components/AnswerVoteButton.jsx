import { ThumbsDown, ThumbsUp } from "@phosphor-icons/react";

const confetti = [
  [-34, -35, -125, "#6f9de8"], [-21, -49, 115, "#8ccbb8"],
  [-5, -43, -80, "#e9c16b"], [15, -51, 150, "#a5a0d9"],
  [31, -34, -145, "#78b7e7"], [40, -14, 110, "#8ccbb8"],
  [29, 9, -65, "#e9c16b"], [12, 20, 145, "#6f9de8"],
  [-15, 17, -150, "#a5a0d9"], [-35, 2, 90, "#78b7e7"],
];
const sparks = [
  [-24, -10, 0, "#b6929a"], [-15, 18, 0, "#c1a4ab"],
  [0, 26, 0, "#b6929a"], [17, 19, 0, "#c1a4ab"],
  [25, -7, 0, "#b6929a"], [4, -22, 0, "#c1a4ab"],
];

export function AnswerVoteButton({ value, feedback, reaction, disabled, onClick }) {
  const Icon = value === "up" ? ThumbsUp : ThumbsDown;
  const active = feedback === value;
  const effect = reaction?.value === value ? reaction : null;
  const label = value === "up" ? "回答有帮助" : "回答需改进";
  return (
    <button
      className={`chat-vote-button is-${value}${active ? " is-active" : ""}${effect ? " is-reacting" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={active ? `${label}，再次点击取消` : label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="chat-vote-icon" key={effect?.id || value}>
        <Icon size={16} weight={active ? "fill" : "regular"} />
      </span>
      {effect ? (
        <span className="chat-vote-burst" key={`burst-${effect.id}`} aria-hidden="true">
          <span className="chat-vote-ring" />
          {(value === "up" ? confetti : sparks).map(([x, y, turn, color], index) => (
            <i key={index} style={{ "--particle-x": `${x}px`, "--particle-y": `${y}px`, "--particle-turn": `${turn}deg`, "--particle-color": color, "--particle-delay": `${index % 3 * 25}ms` }} />
          ))}
        </span>
      ) : null}
    </button>
  );
}
