# ARES Core Payload

This directory is the runtime-neutral entrypoint for the packaged harness.
`manifest.json` currently resolves the source tree through `../mishkan` so the
first portability release does not duplicate or move the existing payload.

Target adapters must resolve core files through this manifest. A later layout
migration can move each domain under `payload/core/` by changing `sourceRoot`
without changing target installers or the published CLI contract.
