import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

type ResponseMode = "valid" | "invalid" | "503" | "hang"

export function wellknownFixture() {
  const origin = "http://127.0.0.1:8787"
  let available = true
  let revision = 0
  let model = "fixture-org/fixture-chat"
  let response = "valid" as ResponseMode
  const requests: Array<{ path: string; response: ResponseMode; revision: number; manifestAvailable: boolean }> = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        requests.push({ path: url.pathname, response, revision, manifestAvailable: available })
        if (url.origin !== origin) return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
        if (url.pathname === "/.well-known/opencode")
          return HttpClientResponse.fromWeb(
            request,
            available
              ? Response.json({
                  auth: { command: ["fixture-login-never-executed"], env: "FIXTURE_TOKEN" },
                  config: { username: `Fixture revision ${revision}` },
                  remote_config: {
                    url: `${origin}/config`,
                    headers: { authorization: "Bearer {env:FIXTURE_TOKEN}" },
                  },
                })
              : new Response(null, { status: 503 }),
          )
        if (url.pathname !== "/config") return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))
        if (request.headers.authorization !== "Bearer fixture-token")
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))
        if (response === "hang") return yield* Effect.never
        if (response === "503") return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            response === "invalid"
              ? { providers: 42, enabled_providers: 42 }
              : {
                  model,
                  providers: { "fixture-org": { package: "native", models: { "fixture-chat": {} } } },
                  enabled_providers: ["fixture-org"],
                },
          ),
        )
      }),
    ),
  )
  return {
    origin,
    model: (next: string) => {
      model = next
    },
    http,
    requests,
    manifest: (next: boolean) => {
      available = next
    },
    revise: () => {
      revision += 1
    },
    remote: (next: ResponseMode) => {
      response = next
    },
  }
}
