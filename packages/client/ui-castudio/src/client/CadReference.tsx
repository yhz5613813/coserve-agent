import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './cad-reference.ts'
import css from './CadReference.module.css'

/** Render a sent CAD selection using the native file-reference treatment. */
export function CadReference({ node }: UserTextNodeProps<'cad-selection'>) {
  return <span className={css.reference}><ReferenceChip appearance="file" label={node.data.label} title={`${node.data.label}\n${node.data.file}`} /></span>
}

/** Render the part a sent message continues using the native folder-reference treatment. */
export function CadPartReference({ node }: UserTextNodeProps<'cad-part'>) {
  return <span className={css.reference}><ReferenceChip appearance="folder" label={node.data.name} title={`${node.data.name}\n${node.data.folder}`} /></span>
}
