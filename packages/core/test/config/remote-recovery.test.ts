import path from "path"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { Credential } from "@opencode/core/credential"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { WellKnown } from "@opencode/core/wellknown"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { wellknownFixture } from "../fixture/wellknown"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.live(
  "retains validated remote settings after invalid HTTP-200 config and a later 503",
  () =>
    Effect.gen(function* () {
      const fixture = yield* configurationFixture()
      yield* Effect.gen(function* () {
        const wellknown = yield* WellKnown.Service
        const credentials = yield* Credential.Service
        const entry = yield* wellknown.add(fixture.origin)
        yield* credentials.create({
          integrationID: entry.integrationID,
          value: Credential.Key.make({ type: "key", key: "fixture-token" }),
        })
        // Fresh Config acquisitions make each read a completed load. The real
        // global WellKnown service remains shared across all four acquisitions.
        const before = yield* freshEntries()
        expect(
          ConfigNormalize.normalize({ providers: 42, enabled_providers: 42 }).diagnostics.some(
            (diagnostic) => diagnostic.kind === "invalid" && diagnostic.path[0] === "enabled_providers",
          ),
        ).toBe(true)
        fixture.remote("invalid")
        const invalid = yield* freshEntries()
        fixture.remote("503")
        const failed = yield* freshEntries()
        fixture.remote("valid")
        const healed = yield* freshEntries()

        expect(before.some((entry) => entry.type === "document" && entry.info.providers?.["fixture-org"])).toBe(true)
        expect(before.some((entry) => entry.type === "document" && entry.info.experimental?.policies?.length)).toBe(
          true,
        )
        expect(
          fixture.requests.filter((request) => request.path === "/config").map((request) => request.response),
        ).toEqual(["valid", "invalid", "503", "valid"])
        expect(healed).toEqual(before)
        expect(failed.some((entry) => entry.type === "document" && entry.info.providers?.["fixture-local"])).toBe(true)
        expect({ invalid, failed }).toEqual({ invalid: before, failed: before })
      }).pipe(Effect.provide(fixture.layer))
    }).pipe(Effect.timeout("5 seconds")),
  6000,
)

it.live(
  "retains the previous complete snapshot when a manifest changes but the remote request fails",
  () =>
    Effect.gen(function* () {
      const fixture = yield* configurationFixture()
      yield* Effect.gen(function* () {
        const wellknown = yield* WellKnown.Service
        const entry = yield* wellknown.add(fixture.origin)
        const before = yield* wellknown.resolve(entry, { FIXTURE_TOKEN: "fixture-token" }, "fixture-credential")
        fixture.revise()
        fixture.remote("503")
        expect(yield* wellknown.refresh()).toBe(true)
        const current = (yield* wellknown.entries()).find((value) => value.origin === fixture.origin)
        if (!current) return yield* Effect.fail(new Error("Manifest disappeared from fixture"))
        const during = yield* wellknown.resolve(current, { FIXTURE_TOKEN: "fixture-token" }, "fixture-credential")
        fixture.remote("valid")
        const healed = yield* wellknown.resolve(current, { FIXTURE_TOKEN: "fixture-token" }, "fixture-credential")

        expect(current.manifest.config?.username).toBe("Fixture revision 1")
        expect(before[0]?.username).toBe("Fixture revision 0")
        expect(during).toEqual(before)
        expect(during[0]?.username).not.toBe(current.manifest.config?.username)
        expect(healed[0]?.username).toBe("Fixture revision 1")
        expect(
          fixture.requests.filter((request) => request.path === "/config").map((request) => request.response),
        ).toEqual(["valid", "503", "valid"])
      }).pipe(Effect.provide(fixture.layer))
    }).pipe(Effect.timeout("5 seconds")),
  6000,
)

it.live(
  "preserves remote model file substitutions during validated refresh",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fixture = yield* configurationFixture()
      const modelFile = path.join(tmp.path, "model.txt")
      yield* Effect.promise(() => Bun.write(modelFile, "fixture-org/fixture-chat"))
      fixture.model(`{file:${modelFile}}`)
      yield* Effect.gen(function* () {
        const wellknown = yield* WellKnown.Service
        const credentials = yield* Credential.Service
        const entry = yield* wellknown.add(fixture.origin)
        yield* credentials.create({
          integrationID: entry.integrationID,
          value: Credential.Key.make({ type: "key", key: "fixture-token" }),
        })
        const before = yield* freshEntries()
        fixture.remote("503")
        const during = yield* freshEntries()
        const document = before.find((entry) => entry.type === "document" && entry.info.providers?.["fixture-org"])
        expect(
          document?.type === "document"
            ? `${document.info.model?.providerID}/${document.info.model?.model}`
            : undefined,
        ).toBe("fixture-org/fixture-chat")
        expect(during).toEqual(before)
        expect(
          fixture.requests.filter((request) => request.path === "/config").map((request) => request.response),
        ).toEqual(["valid", "503"])
      }).pipe(Effect.provide(fixture.layer))
    }).pipe(Effect.timeout("5 seconds")),
  6000,
)

it.live(
  "times out a hung remote config fetch after 15 seconds and retains the last-good config",
  () =>
    Effect.gen(function* () {
      const fixture = yield* configurationFixture()
      yield* Effect.gen(function* () {
        const wellknown = yield* WellKnown.Service
        const entry = yield* wellknown.add(fixture.origin)
        const variables = { FIXTURE_TOKEN: "fixture-token" }
        const before = yield* wellknown.resolve(entry, variables, "fixture-credential")
        fixture.remote("hang")
        const during = yield* Effect.gen(function* () {
          const pending = yield* wellknown
            .resolve(entry, variables, "fixture-credential")
            .pipe(Effect.forkScoped({ startImmediately: true }))
          yield* TestClock.adjust("15 seconds")
          return yield* Fiber.join(pending)
        }).pipe(Effect.provide(TestClock.layer()))
        expect(during).toEqual(before)
        expect(
          fixture.requests.filter((request) => request.path === "/config").map((request) => request.response),
        ).toEqual(["valid", "hang"])
      }).pipe(Effect.provide(fixture.layer))
    }).pipe(Effect.timeout("5 seconds")),
  6000,
)

const freshEntries = Effect.fn("fixture.freshEntries")(function* () {
  return yield* Config.Service.use((config) => config.entries()).pipe(
    Effect.provide(
      Config.layer({
        global: false,
        project: false,
        content: JSON.stringify({
          providers: { "fixture-local": { package: "native", models: { "local-chat": {} } } },
        }),
      }),
    ),
    Effect.scoped,
  )
})

const configurationFixture = Effect.fn("fixture.configurationFixture")(function* () {
  const tmp = yield* tmpdirScoped()
  const fixture = wellknownFixture()
  return {
    ...fixture,
    layer: AppNodeBuilder.build(
      LayerNode.group([
        Bus.node,
        Credential.node,
        KV.node,
        WellKnown.node,
        Watcher.node,
        Location.node,
        Global.node,
        FSUtil.node,
      ]),
      [
        httpClient.replace(fixture.http),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) }))),
        ),
        Global.node.replace(Global.layerWith({ config: path.join(tmp.path, "global"), home: tmp.path })),
        Watcher.node.replace(Watcher.testLayer),
      ],
    ),
  }
})
