# Memory STAK — Brand identity v1.0 ("Lifted")

Symbol: open orange isometric ring floating above one graphite base (machine). The gap = environment not tied to hardware. Never close it.

Hierarchy: **Memory STAK** = brand, **STAK** = product. In lockups "Memory" is IBM Plex Sans 400 #A39D93, "STAK" is IBM Plex Sans 700 #ECE7DF, letter-spacing .02em, word gap .28em. STAK always dominant.

## Files

| file                                         | use                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stak-symbol-dark.svg                         | symbol on dark (site header, docs)                                                                                                                                              |
| stak-symbol-light.svg                        | symbol on light                                                                                                                                                                 |
| stak-symbol-mono-white.svg / -mono-black.svg | one-color                                                                                                                                                                       |
| memory-stak-lockup-dark/light.svg            | primary lockup — text is live `<text>`, not outlined; only safe where IBM Plex Sans is loaded (the website). Not used in the README/OG, which need to render without that font. |
| stak-lockup-dark/light.svg                   | compact lockup — same live-text caveat as above                                                                                                                                 |
| stak-favicon.svg                             | favicon source                                                                                                                                                                  |
| stak-avatar.svg                              | GitHub org / social avatar (512, circle-safe)                                                                                                                                   |
| stak-app-icon.svg                            | rendered app icon / apple-touch-icon (1024) — only place gradients are allowed                                                                                                  |

## Tokens

```
--stak-signal: #E8793A;        /* ring, accent */
--stak-signal-light: #D96A2B;  /* accent on light bg */
--stak-signal-shade: #B0531F;
--stak-ink: #ECE7DF;
--stak-ink-muted: #A39D93;
--stak-graphite: #0E0D0C;
--stak-base-lit: #4A4743;
--stak-base-shade: #2A2826;
--stak-paper: #F3F0EA;
--stak-ink-light: #141311;
```

Fonts: IBM Plex Sans (400/500/700), IBM Plex Mono (400/500).

## Rules

- Full symbol ≥ 24px; below that use favicon art. Primary lockup ≥ 140px wide, compact ≥ 80px.
- Clear space = ¼ symbol height. Symbol height ≈ 1.75× wordmark cap height; symbol→text gap 0.45× symbol height.
- Don't: close the gap, add rings, recolor base, rotate, outline/shadow, enlarge "Memory".

Source: Claude Design project "Memory STAK logo directions" (approved v1.0, Oct 2026).
