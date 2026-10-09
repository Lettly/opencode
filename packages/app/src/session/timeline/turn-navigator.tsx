import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import { createMemo, createSelector, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { readPromptPresentation } from "@/composer/comment-note"
import { useServerSDK } from "@/runtime/server/client"

const turnPageLimit = 200

// Previews clamp to a few lines; keep only enough text to fill them.
const previewLength = 400

type TurnNavigatorProps = {
  sessionID: string
  messages: Accessor<SessionMessageInfo[]>
  /** Whether the loaded messages reach the start of the session, making the index redundant. */
  complete: Accessor<boolean>
  assistantMessagesByParent: Accessor<Map<string, SessionMessageAssistant[]>>
  revertMessageID: Accessor<string | undefined>
  activeUserMessageID: Accessor<string | undefined>
  onSelect: (id: string) => void
}

/**
 * A mouse rail of the session's user turns beside the timeline. While older history is unloaded, turns come from the
 * server's user-message index; a turn's response previews only once its messages are loaded. Keyboard users move
 * between turns with the previous and next message commands.
 *
 * Nothing loads or renders until a mouse first moves over the timeline, which keeps the rail off session entry and
 * tab switches. The rail then appears once it lists every turn, so it never grows under the pointer.
 */
export function TurnNavigator(props: TurnNavigatorProps) {
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ engaged: boolean; index?: Map<string, string> }>({ engaged: false })
  let root: HTMLDivElement | undefined

  const loadIndex = async (cursor?: string): Promise<[string, string][]> => {
    const page = await sdk.api.message.list({
      sessionID: props.sessionID,
      type: "user",
      limit: turnPageLimit,
      ...(cursor ? { cursor } : { order: "asc" as const }),
    })
    const turns = page.data.flatMap((message) =>
      message.type === "user" ? [[message.id, promptPreview(message)] as [string, string]] : [],
    )

    if (page.data.length < turnPageLimit || !page.cursor.next) return turns

    return [...turns, ...(await loadIndex(page.cursor.next))]
  }

  onMount(() => {
    const timeline = root?.parentElement

    if (!timeline) return

    const engage = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      timeline.removeEventListener("pointermove", engage)
      setState("engaged", true)

      if (props.complete()) return
      // Plain state rather than a resource: a pending resource would suspend the timeline it decorates.
      // On failure the rail lists the loaded turns.
      void loadIndex()
        .catch(() => [])
        .then((turns) => setState("index", new Map(turns)))
    }

    timeline.addEventListener("pointermove", engage)
    onCleanup(() => timeline.removeEventListener("pointermove", engage))
  })

  return (
    <div
      ref={root}
      data-component="session-turn-navigator"
      aria-hidden="true"
      class="absolute start-0 top-14 bottom-20 z-[50] flex w-5 flex-col justify-center pointer-events-none"
    >
      <Show when={state.engaged && (props.complete() || state.index)}>
        <TurnRail {...props} index={state.index} root={root!} />
      </Show>
    </div>
  )
}

function TurnRail(props: TurnNavigatorProps & { index?: Map<string, string>; root: HTMLDivElement }) {
  const [state, setState] = createStore<{ hover?: { id: string; top: number } }>({})

  const loaded = createMemo(
    () =>
      new Map(props.messages().flatMap((message) => (message.type === "user" ? [[message.id, message] as const] : []))),
  )

  const turns = createMemo(() => {
    const revert = props.revertMessageID()

    return [...new Set([...(props.index?.keys() ?? []), ...loaded().keys()])]
      .filter((id) => !revert || id < revert)
      .toSorted()
  })

  const active = createSelector(props.activeUserMessageID)
  const hovered = createSelector(() => state.hover?.id)

  const preview = createMemo(() => {
    const hover = state.hover

    if (!hover) return
    const message = loaded().get(hover.id)
    const text = props
      .assistantMessagesByParent()
      .get(hover.id)
      ?.flatMap((item) => item.content)
      .findLast((content) => content.type === "text" && content.text.trim())

    return {
      top: hover.top,
      prompt: message ? promptPreview(message) : props.index?.get(hover.id),
      response: text?.type === "text" ? previewText(text.text) : undefined,
    }
  })

  const turnAt = (event: MouseEvent) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>("[data-turn]") : null

  const hover = (event: PointerEvent) => {
    const tick = turnAt(event)
    const id = tick?.dataset.turn

    if (!tick || !id || state.hover?.id === id) return
    const box = tick.getBoundingClientRect()
    setState("hover", { id, top: box.top + box.height / 2 - props.root.getBoundingClientRect().top })
  }

  return (
    <Show when={turns().length > 1}>
      <div
        class="flex max-h-full min-h-0 cursor-pointer flex-col py-1 pointer-events-auto"
        onPointerMove={hover}
        onPointerLeave={() => setState("hover", undefined)}
        onClick={(event) => {
          const id = turnAt(event)?.dataset.turn

          if (id) props.onSelect(id)
        }}
      >
        <For each={turns()}>
          {(id) => (
            <div
              data-turn={id}
              data-state={hovered(id) ? "hovered" : active(id) ? "active" : undefined}
              class="group flex h-2 min-h-0 w-5 shrink items-center ps-1"
            >
              <span class="block h-0.5 w-2 rounded-full bg-v2-icon-icon-faint transition-[width,background-color] duration-150 motion-reduce:transition-none group-data-[state=active]:w-3 group-data-[state=active]:bg-v2-icon-icon-base group-data-[state=hovered]:w-3.5 group-data-[state=hovered]:bg-v2-text-text-base" />
            </div>
          )}
        </For>
      </div>
      <Show when={preview()}>
        {(item) => (
          <div
            data-slot="session-turn-navigator-preview"
            class="absolute start-6 w-[320px] max-w-[calc(100vw-4rem)] -translate-y-1/2 rounded-lg bg-v2-background-bg-base px-3 py-2"
            style={{ top: `${item().top}px`, "box-shadow": "var(--v2-elevation-raised)" }}
          >
            <p class="line-clamp-2 text-[13px] font-[530] leading-text-compact text-v2-text-text-base">
              {item().prompt}
            </p>
            <Show when={item().response}>
              {(text) => (
                <p class="mt-1 line-clamp-3 text-[13px] leading-text-compact text-v2-text-text-muted">{text()}</p>
              )}
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}

function promptPreview(message: SessionMessageUser) {
  return previewText(readPromptPresentation(message.metadata)?.displayText ?? message.text)
}

function previewText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, previewLength)
}
