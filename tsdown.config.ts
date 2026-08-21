import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-scroll-flow',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
