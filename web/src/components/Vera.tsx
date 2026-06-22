import { MOOD_COLOR, MOOD_SHADOW, MOOD_MARK, type Mood } from "@/lib/verity";

/** Vera — the reviewer presence. Rounded-square body, pulse ring, breathes when
 *  calm / shakes when alarmed, with a mood "mark" (dots, check, !, ✕). */
export function Vera({ mood, label, says }: { mood: Mood; label: string; says: string }) {
  const color = MOOD_COLOR[mood];
  const shadow = MOOD_SHADOW[mood];
  const mark = MOOD_MARK[mood];
  const bodyAnim = mood === "alarmed"
    ? "vr-shake .5s ease-in-out infinite"
    : "vr-breathe 3.6s ease-in-out infinite";
  const cardBg = mood === "alarmed" ? "#FCEDEC" : mood === "happy" ? "#EFF8F3" : "#FFFFFF";
  const cardBorder = mood === "alarmed" ? "#F0BFBB" : mood === "happy" ? "#BFE3D2" : "#E8E4DA";

  return (
    <div style={{
      display: "flex", gap: 20, alignItems: "center",
      background: cardBg, border: `1px solid ${cardBorder}`, borderRadius: 18,
      padding: "22px 24px", transition: "background .5s, border-color .5s",
    }}>
      <div style={{ position: "relative", width: 100, height: 100, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{
          position: "absolute", width: 100, height: 100, borderRadius: "50%",
          background: color, opacity: 0.28, animation: "vr-pulse 2.4s ease-out infinite",
        }} />
        <div style={{
          animation: bodyAnim, position: "relative", width: 80, height: 80, borderRadius: 27,
          background: color, boxShadow: `0 12px 28px ${shadow}`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {mood === "thinking" && (
            <span style={{
              position: "absolute", inset: -8, borderRadius: 32,
              border: "2.5px solid rgba(255,255,255,.55)", borderTopColor: "transparent",
              borderRightColor: "transparent", animation: "vr-think 1.1s linear infinite",
            }} />
          )}
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#fff"
            strokeWidth={mark.sw} strokeLinecap="round" strokeLinejoin="round">
            <path d={mark.path} />
          </svg>
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color, marginBottom: 5 }}>
          Vera · {label}
        </div>
        <div style={{ fontSize: 16.5, fontWeight: 500, color: "#20232A", lineHeight: 1.4 }}>
          {says}
        </div>
      </div>
    </div>
  );
}
