import { html } from "lit";
import { pluginFallbackGradient, pluginMonogram } from "../pages/plugins/presentation.ts";
import { imageWithFallback } from "./image-with-fallback.ts";
import "../styles/channels.css";

export function renderChannelIcon(
  channelId: string,
  label: string,
  variant: "tile" | "cover" | "picker" | "glyph",
  options: { pluginIconUrl?: string } = {},
) {
  const artVariant = variant === "picker" || variant === "glyph" ? "tile" : variant;
  return html`${imageWithFallback(options.pluginIconUrl, (art, onError) => {
    const [from, to] = art ? ["", ""] : pluginFallbackGradient(channelId);
    const style = `${
      variant === "picker"
        ? "--channels-art-size:24px;"
        : variant === "glyph"
          ? "--channels-art-size:18px;"
          : ""
    }${art ? "" : `--channels-art-a:${from};--channels-art-b:${to}`}`;
    const packageCoverClass =
      variant === "cover" && options.pluginIconUrl ? " channels-cover--icon" : "";
    return html`<span
      class=${`channels-${artVariant}${packageCoverClass}${art ? "" : ` channels-${artVariant}--fallback`}`}
      style=${style}
      aria-hidden="true"
    >
      ${
        art
          ? html`<img src=${art} alt="" loading="lazy" decoding="async" @error=${onError} />`
          : html`<span>${pluginMonogram(label)}</span>`
      }
    </span>`;
  })}`;
}
