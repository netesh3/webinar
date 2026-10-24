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

/* RedispatchIdle re-creates room's dispatch of agentName when no job of it is pending or
 * running: a dispatch made while no worker of that name was registered (the captions box still
 * booting) or while every worker was full, or whose job ended without the room asking. LiveKit
 * assigns a dispatch when it is created, so re-creating it now that a worker may be there is
 * what gets the agent in. A dispatch with a live job is left alone, so this never puts a second
 * agent in a room. Reports whether it re-created one. No dispatch at all: nothing to do (the
 * session's own sync makes the first). */
func (c *Client) RedispatchIdle(ctx context.Context, room, agentName string) (bool, error) {
	list, err := c.agents.ListDispatch(ctx, &livekit.ListAgentDispatchRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return false, nil
		}
		return false, err
	}
	var idle *livekit.AgentDispatch
	for _, d := range list.GetAgentDispatches() {
		if d.GetAgentName() != agentName {
			continue
		}
		for _, j := range d.GetState().GetJobs() {
			switch j.GetState().GetStatus() {
			case livekit.JobStatus_JS_PENDING, livekit.JobStatus_JS_RUNNING:
				return false, nil
			}
		}
		if idle == nil {
			idle = d
		}
	}
	if idle == nil {
		return false, nil
	}
	if _, err := c.agents.DeleteDispatch(ctx, &livekit.DeleteAgentDispatchRequest{
		DispatchId: idle.GetId(), Room: room,
	}); err != nil && !isNotFound(err) {
		return false, err
	}
	if _, err := c.agents.CreateDispatch(ctx, &livekit.CreateAgentDispatchRequest{
		AgentName: agentName, Room: room, Metadata: idle.GetMetadata(),
	}); err != nil {
		return false, err
	}
	return true, nil
}
