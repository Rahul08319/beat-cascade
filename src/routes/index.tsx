import { createFileRoute } from "@tanstack/react-router";
import PixelPulseRush from "@/components/PixelPulseRush";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pixel Pulse Rush — Neon Chiptune Rhythm Game" },
      {
        name: "description",
        content:
          "Tap to the beat as neon pixel blocks cascade in sync with a procedurally generated chiptune. Every run is unique.",
      },
      { property: "og:title", content: "Pixel Pulse Rush" },
      {
        property: "og:description",
        content:
          "A neon 8-bit rhythm rush. Tap the lanes, build combos, share your score.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return <PixelPulseRush />;
}
