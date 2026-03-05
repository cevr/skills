import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { runCli } from "./cli.js"
import { GitHub } from "./services/GitHub.js"
import { SkillStoreLive } from "./services/SkillStore.js"
import { SkillLockLive } from "./services/SkillLock.js"

const AppLayer = SkillLockLive.pipe(
  Layer.provideMerge(SkillStoreLive),
  Layer.provideMerge(GitHub.Live),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(BunContext.layer),
)

runCli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain)
