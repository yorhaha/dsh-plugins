/**
 * Shared harness for the dsh-stock Host half's local checks: a stub context
 * that mounts the real plugin the way the Loader would.
 *
 * Run from the plugin directory after `pnpm install`.
 */
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'

/**
 * Mount the plugin against stub services, as the Loader would.
 *
 * @param options - mount inputs.
 * @param options.config - the row's `config`, validated by the plugin.
 * @returns the registered tools by name and the registered prompt sections.
 */
export async function mountHost({ config }) {
  const tools = new Map()
  const sections = []
  const ctx = {
    // Only MCP_SERVERS is reachable: `getSectionOrder` throws on an unknown
    // name, so a mistyped order fails the mount here as it would at load.
    systemPrompt: {
      getSectionOrder(name) {
        if (name !== 'MCP_SERVERS') throw new Error(`stock: unexpected section order name '${name}'`)
        return 3100
      },
      section(section) {
        sections.push(section)
        return () => {
          const at = sections.indexOf(section)
          if (at >= 0) sections.splice(at, 1)
        }
      },
    },
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.output.schema)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  await apply(ctx, config)
  return { tools, sections }
}
