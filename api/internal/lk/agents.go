package lk

import (
	"context"

	"github.com/livekit/protocol/livekit"
)

/* Agent dispatch, for the server caption agent (deploy/captions).
 *
 * The agent registers with LiveKit under an agent name and is never dispatched
 * automatically (explicit dispatch): it joins a room only when the API asks, which is when
 * a host turns server captions on. Both calls are idempotent so a double click, or a retry
 * after a timeout, cannot put two caption agents in one room. */

/* CaptionAgentPrefix starts the identity the caption agent joins with (CAP_<room>, set in
 * deploy/captions/agent.py). Filtered out of every roster and count like an egress, and
 * mirrored by isBotOrEgress in web/lib/roster.ts. The agent also joins hidden, without
 * publish rights, so no browser draws a tile for it either way. */
const CaptionAgentPrefix = "CAP_"

// DispatchAgent makes sure exactly one dispatch of agentName exists for room. metadata is
// handed to the agent with the job. Returns the dispatch id.
func (c *Client) DispatchAgent(ctx context.Context, room, agentName, metadata string) (string, error) {
	list, err := c.agents.ListDispatch(ctx, &livekit.ListAgentDispatchRequest{Room: room})
	if err != nil && !isNotFound(err) {
		return "", err
	}
	for _, d := range list.GetAgentDispatches() {
		if d.GetAgentName() == agentName {
			return d.GetId(), nil
		}
	}
	d, err := c.agents.CreateDispatch(ctx, &livekit.CreateAgentDispatchRequest{
		AgentName: agentName,
		Room:      room,
		Metadata:  metadata,
	})
	if err != nil {
		return "", err
	}
	return d.GetId(), nil
}

// StopAgent deletes every dispatch of agentName in room, which makes LiveKit end the agent's
// job: the agent disconnects and runs its shutdown (the after-session transcript). A room
// that no longer exists has nothing to stop.
func (c *Client) StopAgent(ctx context.Context, room, agentName string) error {
	list, err := c.agents.ListDispatch(ctx, &livekit.ListAgentDispatchRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return nil
		}
		return err
	}
	for _, d := range list.GetAgentDispatches() {
		if d.GetAgentName() != agentName {
			continue
		}
		if _, err := c.agents.DeleteDispatch(ctx, &livekit.DeleteAgentDispatchRequest{
			DispatchId: d.GetId(), Room: room,
		}); err != nil && !isNotFound(err) {
			return err
		}
	}
	return nil
}
