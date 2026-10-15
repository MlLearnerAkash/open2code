import { Plugin } from "@opencode/plugin/tui"

// Shows the cloud SSH host used by the open2code failover wrapper in the prompt
// footer (bottom-right). The wrapper exports OPEN2CODE_SSH; without it this
// plugin renders nothing, so it is inert for a normal `opencode` launch.
export default Plugin.define({
  id: "open2code.ssh",
  setup(context) {
    const host = process.env.OPEN2CODE_SSH
    if (!host) return
    context.ui.slot({
      append: "prompt.footer",
      render: () => (
        <text fg={context.theme.text.muted} wrapMode="none" flexShrink={0}>
          {`ssh ${host}`}
        </text>
      ),
    })
  },
})
