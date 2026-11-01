# Bundled upstream Python CLI

Unmodified files from [NextProto's AI recorder card open protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol/tree/de42d1fbf19fc92064ac4688f71f42730c82267f), commit `de42d1fbf19fc92064ac4688f71f42730c82267f`.

Copyright (c) 2026 NextProto. The full MIT notice is in [LICENSE](LICENSE).
[SOURCE.json](SOURCE.json) records normalized SHA-256 checksums of every copied file.

Use the plugin's `runtime/recorder_cli.py` entry point, not these scripts directly.
The adapter validates source hashes, handles incomplete responses and safe publication,
and redirects output/cache/config paths to the user's data directory. Python,
Bleak and requests are installed separately; no upstream checkout is needed.

To update: review the new upstream revision and license, copy the listed files without
editing, update SOURCE.json and adapter hashes together, and rerun package, Python,
Host and device acceptance checks. Do not copy an upstream working directory or secrets.
