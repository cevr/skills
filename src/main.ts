import { BunServices, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { runCli } from "./cli.js"
import { GitHub } from "./services/GitHub.js"
import { SkillStoreLive } from "./services/SkillStore.js"
import { SkillLockLive } from "./services/SkillLock.js"

const PlatformLayer = FetchHttpClient.layer.pipe(Layer.provideMerge(BunServices.layer))

const AppLayer = SkillLockLive.pipe(
  Layer.provideMerge(SkillStoreLive),
  Layer.provideMerge(GitHub.layer),
  Layer.provideMerge(PlatformLayer),
)

runCli.pipe(Effect.provide(AppLayer), BunRuntime.runMain)
