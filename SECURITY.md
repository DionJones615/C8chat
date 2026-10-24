# Security Policy

## Supported versions

C8 Chat is supported on the latest published release. The current release line is
`1.x`. Older builds may not receive fixes.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

- Once the repository is public, use GitHub's private vulnerability reporting
  from the repository's **Security** tab.
- You can also email **dion.jones@gmail.com** with a description, reproduction
  steps, affected version, and any relevant logs or screenshots.

Do not include real account keys, private messages, or other players' personal
information in a report unless it is necessary and you have permission.

## What to include

- The affected version (`chrome://extensions` or `about:addons`).
- Browser and operating system.
- A clear description of the issue and its impact.
- Reproduction steps or a minimal proof of concept.
- Whether the issue is already public.

## Scope

In scope:

- The extension's source, manifest, permissions, and packaging.
- Data handling, local storage, and diagnostic data.
- The WebSocket tee, page bridge, key injection, and private-message path.
- Supply-chain and release automation in `.github/`.

Out of scope:

- Vulnerabilities in the Castle Infinity game or its servers. Report those to the
  game's operators.
- Issues that require an already-compromised browser profile or device.
- Social engineering or physical access.

## Response

The maintainer aims to acknowledge reports within 7 days and to provide a status
update within 30 days. Timelines depend on severity and reproducibility. There is
no bug bounty.

## Safe harbor

Good-faith research that respects users' privacy and does not disrupt the game or
other players is welcome. Do not access other players' data or accounts.
