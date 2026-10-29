# Privacy and publication

The extension does not add telemetry or a cloud service. Layouts, named presets,
LoRA tags and workspace preferences save in the current browser's local storage.
Forge generation sends prompts through the user's existing Forge instance.
Clipboard access happens when the user chooses a copy action. A reference
underlay stays in the browser; native Forge handles generated image storage.

This repository is a new source snapshot, without the development workspace's
Git history. It excludes machine-specific setup notes, account details, personal
email addresses, home paths, LAN addresses, GPU identifiers, checkpoint
inventories, private Forge screenshots and raw generation metadata.

The documentation preview is generated from the standalone editor with the
repository's synthetic example. It does not show a real Forge installation.

Development tests can capture local paths, model names, URLs and prompt metadata.
They write these artifacts to ignored `test-results/`, not public documentation.
Credentials and local configuration are also ignored. Do not add generated
artifacts with `git add --force` without reviewing them.

Run `python3 tools/check_public_tree.py` before publishing. It checks files
Git would include for common credentials, personal paths, private network
addresses, GPU identifiers and private email addresses. The checker is an aid;
manual review is still needed for screenshots, examples and new content.
