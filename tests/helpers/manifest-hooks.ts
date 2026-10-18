import type { HookReceiver } from "../../src/main/agents/hook-receiver";
import { agentProvider } from "../../src/main/agents/providers/registry";
export function manifestHooks(receiver: HookReceiver, terminal: string, id: string) {
  const channels = agentProvider(id).model.hooks?.channels ?? [];
  const launch = receiver.register(terminal, id, {
    channels: new Map(channels.map((channel) => [channel.id, channel])),
    state: {},
  });
  return {
    ...launch,
    env: {
      ...launch.env,
      ...Object.fromEntries(channels.map((channel) => [`FOOM_CHANNEL_${channel.id}`, channel.id])),
    },
  };
}
