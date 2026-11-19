# Changelog

All notable changes to Mnemo. Versions follow
[Semantic Versioning](https://semver.org); from 0.1.2 on, this file is
written by release-please from the commit titles. Container images:
`ghcr.io/mnema-xyz/mnemo`.

Mnemo is licensed under the MIT License from the release after 0.1.3. Earlier
releases (up to and including 0.1.3) stay AGPL-3.0-only.

## [0.1.13](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.12...v0.1.13) (2026-11-19)


### Bug Fixes

* **bot:** name the configured attachment limit in the refusals ([#33](https://github.com/mnema-xyz/talk-mnemo-bot/issues/33)) ([eeac947](https://github.com/mnema-xyz/talk-mnemo-bot/commit/eeac94770477fcb6cec0f8378a49c45c7ef56e41))


### Code Refactoring

* enforce the code limits and split the bot ([#31](https://github.com/mnema-xyz/talk-mnemo-bot/issues/31)) ([7cfafd7](https://github.com/mnema-xyz/talk-mnemo-bot/commit/7cfafd7ef936bc98901b0751adf15060cbbe0354))

## [0.1.12](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.11...v0.1.12) (2026-11-19)


### Bug Fixes

* **bot:** admit attachment questions against the rate limits and budget ([#29](https://github.com/mnema-xyz/talk-mnemo-bot/issues/29)) ([695841a](https://github.com/mnema-xyz/talk-mnemo-bot/commit/695841a275acc8e92c48edca47c85315ae3f5a5d))

## [0.1.11](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.10...v0.1.11) (2026-11-17)


### Bug Fixes

* **security:** sanitize html tags repeatedly and check exact hostname in test ([#27](https://github.com/mnema-xyz/talk-mnemo-bot/issues/27)) ([a30d547](https://github.com/mnema-xyz/talk-mnemo-bot/commit/a30d547da43d45321161e751dee2692a476d9e8e))

## [0.1.10](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.9...v0.1.10) (2026-11-15)


### Documentation

* headless setup through POST /api/admin/bots/install ([#11](https://github.com/mnema-xyz/talk-mnemo-bot/issues/11)) ([cd5d575](https://github.com/mnema-xyz/talk-mnemo-bot/commit/cd5d57552572807cff5fc586cb74c8a69a63bb52))

## [0.1.9](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.8...v0.1.9) (2026-11-15)


### Features

* optional admin user ids with command and interaction permissions ([#24](https://github.com/mnema-xyz/talk-mnemo-bot/issues/24)) ([cca378f](https://github.com/mnema-xyz/talk-mnemo-bot/commit/cca378f9aa88386b4575931509fa6e32af3915a5))

## [0.1.8](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.7...v0.1.8) (2026-11-15)


### Features

* read image and file attachments with consent prompt ([#22](https://github.com/mnema-xyz/talk-mnemo-bot/issues/22)) ([8044cff](https://github.com/mnema-xyz/talk-mnemo-bot/commit/8044cff070491675bc882613ffa2598af6d9146a))

## [0.1.7](https://github.com/mnema-xyz/talk-mnemo-bot/compare/v0.1.6...v0.1.7) (2026-11-13)


### Bug Fixes

* the repository is now mnema-xyz/talk-mnemo-bot ([#20](https://github.com/mnema-xyz/talk-mnemo-bot/issues/20)) ([d25aa84](https://github.com/mnema-xyz/talk-mnemo-bot/commit/d25aa84ef3422fbe1a31433a33bd6cefd1c1aeb6))

## [0.1.6](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/compare/v0.1.5...v0.1.6) (2026-11-13)


### Bug Fixes

* take the SDK 3.1.3 (MIT), and say which name an admin's regeneration sends ([#18](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/18)) ([96100ef](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/96100ef91e67a84f812ca2522b5fbe3d1ca793aa))

## [0.1.5](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/compare/v0.1.4...v0.1.5) (2026-11-13)


### Features

* Mnemo's answer details are for admins only, and Regenerate is limited ([#16](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/16)) ([6e664f4](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/6e664f468eaa4f2f964918c13a3a41d13d93ce90))

## [0.1.4](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/compare/v0.1.3...v0.1.4) (2026-11-13)


### Bug Fixes

* relicense Mnemo under MIT ([#9](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/9)) ([0971d63](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/0971d637eb31032f87ff180425a6af14552db40e))
* the release verifies the image signature right after signing it ([#14](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/14)) ([6d0d680](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/6d0d6802a6257accab6e349aaf47bee7061c09c2))

## [0.1.3](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/compare/v0.1.2...v0.1.3) (2026-11-13)


### Bug Fixes

* sign the published image with cosign (keyless) and document how to verify it ([#10](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/10)) ([53b7b21](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/53b7b21c05f9f9ae8441b5dc900360d15dc2ac95))

## [0.1.2](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/compare/v0.1.1...v0.1.2) (2026-11-13)


### Features

* publish the Mnemo image to GHCR, with release automation and a Dockerfile check ([#7](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/7)) ([8546187](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/8546187fae63e78ccfa57d8e9aef51b6972f60a8))


### Documentation

* explain prompt caching, its settings and how to check it ([#6](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/issues/6)) ([b494002](https://github.com/mnema-xyz/mnema-talk-mnemo-bot/commit/b49400236fd3fa756a4d503133d001a401d27f27))

## [0.1.1] - 2026-11-13

### Changed

- Cheaper answers on Anthropic: Mnemo now uses prompt caching, so the tool
  descriptions and the system prompt, which every call repeats, are billed
  at a tenth of the input price after the first call within 5 minutes. It
  is on by default and needs no setting. Answers are unchanged.
- To make that possible the system prompt no longer contains the time or the
  asker's name; both arrive as a short note in front of the question. If you
  use a custom persona (`MNEMO_SYSTEM_PROMPT`), keep it free of dates and
  IDs, or it cannot be cached.
- The daily cost budget (`MNEMO_DAILY_COST_BUDGET_USD`) now prices cached
  tokens correctly: reads at 0.1 times and writes at 1.25 times the input
  price. The token budget still counts every token. Today's usage is kept
  across the update.
- With `MNEMO_LOG_LEVEL=debug`, each Anthropic call logs `anthropic_cache`
  with how many tokens were read from and written to the cache, so you can
  check that caching works.
- The OpenAI providers behave as before.

## [0.1.0] - 2026-11-13

First release. Requires Mnema Talk 3.1.0 or newer and takes the SDK from
that release.

### Added

- Mnemo answers mentions in a thread under the question, keeps the
  thread's context (bounded), and answers `/ask`, publicly or privately.
- Buttons under answers: Regenerate (for the asker), Details (tools,
  model, tokens, what was sent) and Follow up (a modal, under `/ask`
  answers).
- Providers: Anthropic (default `claude-haiku-5-5`), OpenAI, and any
  OpenAI-compatible server (Ollama, OpenRouter, LM Studio, vLLM), plus a
  fake provider for dry runs and tests.
- Tools: weather and forecast (Open-Meteo), calculator (own parser, no
  `eval`), date and time with time zones, unit conversion, Wikipedia, and
  optional web search (Brave or Tavily).
- Guards: per-member and per-channel rate limits, a daily token or cost
  budget that survives restarts, tool-call and model-call limits, timeouts.
- Configuration from environment variables and an optional JSON file with a
  schema, checked at start; secrets only from the environment or `*_FILE`.
- Manifest with avatar, add link script, Dockerfile (non-root, pinned base
  image), Compose example, health endpoint, JSON logs, graceful shutdown.
- The `openai` provider uses OpenAI's Responses API (nothing stored between
  calls); OpenAI-compatible servers use Chat Completions.
- A hard daily budget: every model call reserves its worst case and settles
  it with the reported usage; failed calls count at their worst case.
- Rate-limit refusals once per member and window for mentions, and privately
  for `/ask` and the buttons.
- A fatal gateway close ends Mnemo with exit code 1, so Docker restarts it.
- Mnemo follows only the threads it starts.
- No answer notifies anyone (`allowed_mentions` with an empty `parse` list).
- An integration test against a real Mnema Talk, and a release check for tags.

[0.1.1]: https://github.com/mnema-xyz/mnema-talk-mnemo-bot/releases/tag/v0.1.1
[0.1.0]: https://github.com/mnema-xyz/mnema-talk-mnemo-bot/releases/tag/v0.1.0
