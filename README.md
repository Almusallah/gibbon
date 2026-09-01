<img src="logo-rounded.png" width="96" align="right">

# Saigon Sampler 🦧♪

A personal pocket sampler and beat machine — record anything (especially the city), chop it onto pads, and work it like a classic MPC: velocity pads, timing-correct with real swing, note repeat, 16 levels, per-pad envelopes and filters, a mixer, and a song mode. Original work; the MPC workflow is emulated from the machine's documented behavior — no third-party code, ROMs, or assets. Offline, autosaves, free. (Formerly "Gibbon".)

**Android:** grab `saigon-sampler.apk` from [Releases → latest](../../releases/latest) on the phone, install (allow "unknown sources" once). Updates install over the top — same signing key, projects survive. Offline instrument; network is used only for the built-in **Saigon Sound Map library** (☰ → Sound Map — 259+ Saigon field recordings, searchable, load to CHOP or a pad).

**iOS / iPad:** open **https://almusallah.github.io/saigon-sampler/** in Safari → Share → **Add to Home Screen**. Runs full-screen and offline, mic works, projects autosave on-device, WAV export goes through the share sheet. Same engine, same features.

## What it does

- **Saigon Sound Map library** — the whole [Sound Map archive](https://saigon-soundscape.onrender.com) (259+ located Saigon field recordings) browsable in-app: search, category filter, shuffle, preview, then **→ CHOP** to slice or **→ PAD** to play. Loaded sounds are saved with the project and work offline afterwards.
- **CHOP lab — field recording → slices**: record a walk up to **6 minutes** (or import a long file), zoom/pan the waveform, tap to audition, **AUTO-SLICE** (transient detection with sensitivity), GRID cuts, drag markers (hold to delete), **→ PADS** spreads slices across pads, full recording → WAV archive. Survives restarts.
- **64 pads** (4 banks) — mic sampling, import, **touch velocity** (tap position = hit strength) with **FULL LEVEL** override, **NOTE REPEAT** on the timing-correct grid, **16 LEVELS** (velocity or tune −12…+3 st), **ERASE** (hold a pad while playing to strip its notes, tap while stopped to clear them).
- **Per-pad sound**: trim, gain, pitch ±12 st + **fine ±50 ct**, pan, **attack/release envelope**, **resonant low-pass filter** with optional **velocity→filter**, one-shot/gate/loop, reverse, normalize, crop, choke groups, **POLY/MONO** voice overlap, copy/paste, keyboard mode with scales.
- **Sequencer (96 PPQ event engine)**: 8 sequences × 1–8 bars, **timing correct** 1/8·1/8T·1/16·1/16T·1/32·1/32T·OFF, **MPC swing 50–75%**, live record with velocity + **1-bar count-in**, **UNDO take** (toggle), **DUP×2** bar-copy, long-press to copy a sequence to another slot, step grid with velocity shading, tap tempo (30–300 BPM), metronome. The clock runs on the audio thread, so timing survives screen-dimming and backgrounding.
- **MIX page**: per-pad level, pan, **mute/solo**.
- **SONG mode**: chain sequences with repeat counts (S1×2 → S3×4), export the whole song.
- **Mix FX** (performable XY, latchable): LP/HP filter, tempo-synced delay, reverb, bit crusher, rhythmic gate — plus **resample** the master back onto a pad.
- **Export WAV** — loop, song, single pad, or the raw field recording, straight to Downloads (Android) or the share sheet (iOS).
- **Projects** — autosave + named slots, on-device.

## Architecture

The instrument is a self-contained web app (`app/src/main/assets/www/`, Web Audio + AudioWorklets for capture, bit-crush, and the sequencer clock) inside a minimal WebView shell providing a secure origin, mic permission, file picker, and a MediaStore bridge for WAV export. CI signs an APK to the `latest` release and deploys the same app to GitHub Pages as an installable PWA on every push.

Dev loop: serve `app/src/main/assets/www/` with any static server; `window.__g` exposes internals; `window.__TEST_CAPTURE = true` diverts WAV exports to `window.__lastWav`.
