/**
 * Types shared by the CAStudio Host and Client faces: the one home of the `cadPart` projection-key declaration.
 *
 * @module @deepseek-ai/dsh-client-ui-castudio/types
 */

export {}

/** The CAD part a Session works on, as its latest logged `<cad-part>` marker names it. */
export interface CadPartProjection {
  /** Root CAD project id. */
  readonly projectId: string
  /** Part slug: `default` for the project root, otherwise the folder name under `parts/`. */
  readonly slug: string
  /** Part display name when the marker was sent. */
  readonly name: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The part named by the Session's latest human `user/message` that carries a valid `<cad-part>` marker, or `null`
     * before one. Included in Session summaries so list rows can show and group by part.
     */
    cadPart: CadPartProjection | null
  }
}
