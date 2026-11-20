import index from './generated/chat-index.json' with { type: 'json' };

/** One concrete destination for a chat capture, with routing evidence for the selecting application. */
export type ChatTarget = {
  readonly path: string;
  readonly schemaUri: string;
  readonly utterance: string;
  readonly distinguish: string;
  readonly parent?: { readonly module: string; readonly path: string };
};

/** Conversation projection of a standard Enbox module. */
export type ChatModule = {
  readonly id: string;
  readonly module: string;
  readonly label: string;
  readonly category: string;
  readonly summary: string;
  readonly identity: string;
  readonly exclude: readonly string[];
  readonly keywords: readonly string[];
  readonly sensitive: boolean;
  readonly paths: readonly ChatTarget[];
  /** Application workflow for operations that need specialized codecs or user actions. */
  readonly workflow?: string;
  readonly interchange?: { readonly format: string; readonly specification: string; readonly scope: string };
};

export const chatDirectory: readonly ChatModule[] = index.modules;

/**
 * Narrow the extractor to the module's allowed capture paths at the given parent type.
 * Supply the selected parent record's verified module and path. Writing a child
 * also requires its real contextId and the user's authority at that record.
 */
export function chatTargetsFor(
  moduleUri: string, parent?: { readonly module: string; readonly path: string },
): readonly ChatTarget[] {
  const module = chatDirectory.find((entry): boolean => entry.module === moduleUri);
  return module?.paths.filter((target): boolean => {
    if (parent === undefined) { return target.parent === undefined; }
    return target.parent?.module === parent.module && target.parent.path === parent.path;
  }) ?? [];
}
