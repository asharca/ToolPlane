# Changelog

## [0.8.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.7.0...toolplane-v0.8.0) (2026-07-14)


### Features

* support OpenAI Responses providers ([#33](https://github.com/asharca/ToolPlane/issues/33)) ([e6a3848](https://github.com/asharca/ToolPlane/commit/e6a3848b6d13c15ca0090820f25663666d80e006))


### Build System

* reduce runtime artifact size ([#34](https://github.com/asharca/ToolPlane/issues/34)) ([812f049](https://github.com/asharca/ToolPlane/commit/812f04946c0217f4f14387ed867ed2d68ed4c9d8))

## [0.7.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.6.0...toolplane-v0.7.0) (2026-07-14)


### Features

* add user timezone preferences ([#31](https://github.com/asharca/ToolPlane/issues/31)) ([b2eae0b](https://github.com/asharca/ToolPlane/commit/b2eae0b3a03069fd7cb6953275d275397d5a5600))


### Bug Fixes

* preserve Hermes assistant message boundaries ([#30](https://github.com/asharca/ToolPlane/issues/30)) ([ea94444](https://github.com/asharca/ToolPlane/commit/ea9444421b20a4d170b857c84820739484bfbfd6))

## [0.6.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.5.0...toolplane-v0.6.0) (2026-07-12)


### Features

* improve frontend usability and performance ([#25](https://github.com/asharca/ToolPlane/issues/25)) ([9855b9b](https://github.com/asharca/ToolPlane/commit/9855b9b9fc3c5d8db98ad2f690db61575c79ea6c))
* improve skill imports and resource selection ([#27](https://github.com/asharca/ToolPlane/issues/27)) ([f4b2fac](https://github.com/asharca/ToolPlane/commit/f4b2fac240d3283803c880605b34b71284898c3c))
* integrate Hermes agent runtime ([#24](https://github.com/asharca/ToolPlane/issues/24)) ([f4ebae1](https://github.com/asharca/ToolPlane/commit/f4ebae16b31b0bea46a9b47aef181a29419396f7))
* support cross-platform sandbox connectors ([#28](https://github.com/asharca/ToolPlane/issues/28)) ([59afd5b](https://github.com/asharca/ToolPlane/commit/59afd5bc6aeadbce676ad635be5ff41d8ee3f915))


### Bug Fixes

* let Hermes own its system prompt ([#26](https://github.com/asharca/ToolPlane/issues/26)) ([397614c](https://github.com/asharca/ToolPlane/commit/397614cf5793423d3ab83a67bf8d0e861b89aa30))

## [0.5.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.4.0...toolplane-v0.5.0) (2026-07-10)


### Features

* add powershell connector support ([#19](https://github.com/asharca/ToolPlane/issues/19)) ([6ab6f58](https://github.com/asharca/ToolPlane/commit/6ab6f58aaff3b344c08a1ef3d8190b51f841dc7c))
* streamline UI and source links ([#21](https://github.com/asharca/ToolPlane/issues/21)) ([4eee90f](https://github.com/asharca/ToolPlane/commit/4eee90fa114fc5f4648e0b8f947cdbf3fe09505b))


### Bug Fixes

* publish connector broker port ([#20](https://github.com/asharca/ToolPlane/issues/20)) ([a33af0b](https://github.com/asharca/ToolPlane/commit/a33af0b643353dd61fd21b2164aab555683466ac))
* send agent system prompt as chat message ([#18](https://github.com/asharca/ToolPlane/issues/18)) ([f4cbe1c](https://github.com/asharca/ToolPlane/commit/f4cbe1c609b998043622d7ab270d14af077a2d94))

## [0.4.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.3.1...toolplane-v0.4.0) (2026-07-09)


### Features

* extend sandbox env and file actions ([#16](https://github.com/asharca/ToolPlane/issues/16)) ([dfaca95](https://github.com/asharca/ToolPlane/commit/dfaca95b64d108690fc6bf888ffd9d149bbc23e2))

## [0.3.1](https://github.com/asharca/ToolPlane/compare/toolplane-v0.3.0...toolplane-v0.3.1) (2026-07-09)


### Bug Fixes

* auto-sync Hermes toolkits on session start ([7bf2c71](https://github.com/asharca/ToolPlane/commit/7bf2c719cffacab5d1ae569f6c8a6712b208e2e4))

## [0.3.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.2.2...toolplane-v0.3.0) (2026-07-09)


### Features

* add tp-skills registry sync ([#12](https://github.com/asharca/ToolPlane/issues/12)) ([f8aa555](https://github.com/asharca/ToolPlane/commit/f8aa5550a644c0b4144404829c329e71ab4123dc))


### Bug Fixes

* expose compose app port ([c71d1fe](https://github.com/asharca/ToolPlane/commit/c71d1fe9350d626150ee5c8beff557e93e0924f8))
* update compose port contract test ([cde4ca7](https://github.com/asharca/ToolPlane/commit/cde4ca71c474eb15f3c8d0c8d2e11394bf7ff48d))

## [0.2.2](https://github.com/asharca/ToolPlane/compare/toolplane-v0.2.1...toolplane-v0.2.2) (2026-07-08)


### Bug Fixes

* align Hermes synced skill names ([18e028c](https://github.com/asharca/ToolPlane/commit/18e028c8bd0d3c0900a4699ae89aae4d8110740d))
* use Hermes skill names for toolkit sync ([2fa43a4](https://github.com/asharca/ToolPlane/commit/2fa43a41dac00e7b30db19d7d42f05be52ff033b))

## [0.2.1](https://github.com/asharca/ToolPlane/compare/toolplane-v0.2.0...toolplane-v0.2.1) (2026-07-08)


### Bug Fixes

* harden Hermes toolkit sync and cleanup ([307e5d9](https://github.com/asharca/ToolPlane/commit/307e5d9fbf15cc5d3376b64005151f1325e83b26))

## [0.2.0](https://github.com/asharca/ToolPlane/compare/toolplane-v0.1.6...toolplane-v0.2.0) (2026-07-08)


### Features

* add manual release workflow ([d23776c](https://github.com/asharca/ToolPlane/commit/d23776c7c11ba4dc021b507e16c6867e62df02bf))
* invite workspace members ([a23373e](https://github.com/asharca/ToolPlane/commit/a23373e3714f56ed8d044df679211bf1986e17e9))
* invite workspace members ([b6ef982](https://github.com/asharca/ToolPlane/commit/b6ef982275fe18586f9274b2670a93605975f738))


### Bug Fixes

* provision postgres for ci tests ([47693c1](https://github.com/asharca/ToolPlane/commit/47693c1bfa1ef1f96dae51e5e9b2878cb4f0a9a7))
* refresh after system update restart ([1956ea0](https://github.com/asharca/ToolPlane/commit/1956ea0f473d1c8f3041d6ac94b5e1f9ec0dae82))

## Changelog

All notable changes to this project will be documented in this file.
