# Validation

The editor was exercised with Forge Neo 2.31, Gradio 4.40.0 and an 8 GB GPU.
The original live integration checks covered an 8-step MOSS Turbo generation,
768×512, Euler/Simple, CFG 1, shift 5 and seed 12345678. One image returned to the
editor and the saved generation prompt matched the compiled layout exactly.
This verifies the workflow at that configuration, rather than all checkpoints,
resolutions or model formats.

Automated format checks cover dimension import, centered coordinates, fractional
edge enclosure, optional metadata, exact Unicode text, character regions,
hidden regions, resolution changes and atomic rejection of invalid imports.

The workspace browser check covers:

- Generate placement and button binding.
- Increasing canvas height using its bottom handle.
- Caption growth without canvas shrinkage.
- Pointer and keyboard panel resizing without prompt changes.
- Panel movement without accidentally reordering image regions.
- Preference restoration across reloads.
- Reset behavior and narrow-window layout.

Other browser checks cover region drawing, undo/redo, draft import/export,
validation, native txt2img/img2img transfers and saved layouts. The renamed public
source is checked separately with the same format and local workspace tests.
Browser tests run in a fresh context; local diagnostics remain in ignored
`test-results/` and are not shipped in the repository.

Cancel checks that it owns the active task before requesting interruption.
Interrupting a GPU job and using an external turbo adapter were not live-tested.
