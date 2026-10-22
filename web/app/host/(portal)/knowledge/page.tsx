import { KnowledgeScreen } from "@/components/knowledge/knowledge-screen";

// "✨ AI knowledge": the documents the live Q&A assistant drafts answers from. Client-rendered
// like the rest of /host: the session is the browser's.
export default function HostKnowledgePage() {
  return <KnowledgeScreen />;
}
