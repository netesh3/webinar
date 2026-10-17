package types

/* The home page's sales chat. See internal/sales and migrations/0105.
 *
 * The visitor's side is public and authenticated by a random token the browser
 * keeps (X-Chat-Token); the admin side is under /api/admin.
 */

// SalesStatus is where a conversation stands.
type SalesStatus string

const (
	SalesAI      SalesStatus = "ai"      // the assistant is answering
	SalesWaiting SalesStatus = "waiting" // a person was asked for; admins were emailed
	SalesHuman   SalesStatus = "human"   // an admin joined
	SalesClosed  SalesStatus = "closed"
)

// SalesRole is who wrote a message.
type SalesRole string

const (
	SalesFromVisitor SalesRole = "visitor"
	SalesFromAI      SalesRole = "ai"
	SalesFromAdmin   SalesRole = "admin"
	SalesFromSystem  SalesRole = "system"
)

type SalesMessage struct {
	// ID increases within a conversation; a poll asks for messages after the last one it has.
	ID         int64     `json:"id"`
	Role       SalesRole `json:"role"`
	AuthorName string    `json:"authorName,omitempty"`
	Body       string    `json:"body"`
	// Emailed is set on an admin reply that went to the visitor's inbox.
	Emailed   bool   `json:"emailed,omitempty"`
	CreatedAt string `json:"createdAt"`
}

/* SalesChat is the visitor's view of their conversation.
 *
 * Token is returned once, when the conversation is created, and is what the browser
 * sends back as X-Chat-Token. TeamOnline is whether an admin has the sales inbox open
 * right now, so the widget can say "usually replies in minutes" or "we'll email you". */
type SalesChat struct {
	Token      string         `json:"token,omitempty"`
	Status     SalesStatus    `json:"status"`
	Name       string         `json:"name,omitempty"`
	Email      string         `json:"email,omitempty"`
	AgentName  string         `json:"agentName,omitempty"`
	TeamOnline bool           `json:"teamOnline"`
	AIEnabled  bool           `json:"aiEnabled"`
	Messages   []SalesMessage `json:"messages"`
}

// StartSalesChatRequest is POST /api/sales/chat.
type StartSalesChatRequest struct {
	// Page is where the visitor opened the chat, for the admin's context.
	Page string `json:"page,omitempty"`
}

// SalesMessageRequest is a visitor's or an admin's message.
type SalesMessageRequest struct {
	Body string `json:"body"`
	// Via, admin only: "chat" or "email". Empty picks email when the visitor has left.
	Via string `json:"via,omitempty"`
}

// SalesContactRequest is POST /api/sales/chat/contact: where to reply if the team misses them.
type SalesContactRequest struct {
	Name  string `json:"name,omitempty"`
	Email string `json:"email"`
}

// SalesHandoffRequest is POST /api/sales/chat/handoff.
type SalesHandoffRequest struct {
	Reason string `json:"reason,omitempty"`
}

// SalesConversation is one row of the admin inbox, and the header of its detail.
type SalesConversation struct {
	ID            string      `json:"id"`
	Status        SalesStatus `json:"status"`
	Name          string      `json:"name,omitempty"`
	Email         string      `json:"email,omitempty"`
	AccountEmail  string      `json:"accountEmail,omitempty"`
	HandoffReason string      `json:"handoffReason,omitempty"`
	HandoffAt     string      `json:"handoffAt,omitempty"`
	AssignedTo    string      `json:"assignedTo,omitempty"`
	Page          string      `json:"page,omitempty"`
	// VisitorOnline is whether the chat is open in the visitor's browser right now.
	VisitorOnline bool   `json:"visitorOnline"`
	LastMessage   string `json:"lastMessage"`
	LastMessageAt string `json:"lastMessageAt"`
	CreatedAt     string `json:"createdAt"`
}

// SalesInbox is GET /api/admin/sales.
type SalesInbox struct {
	NeedsYou      int                 `json:"needsYou"`
	Conversations []SalesConversation `json:"conversations"`
}

// SalesConversationDetail is GET /api/admin/sales/{id}.
type SalesConversationDetail struct {
	Conversation SalesConversation `json:"conversation"`
	Messages     []SalesMessage    `json:"messages"`
}

// Outbox kinds for the sales chat (migrations/0105).
const (
	// NotifySalesHandoff tells admins a visitor needs a person.
	NotifySalesHandoff NotificationKind = "sales_handoff"
	// NotifySalesReply is an admin's reply mailed to a visitor who left the chat.
	NotifySalesReply NotificationKind = "sales_reply"
)
