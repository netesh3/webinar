/* Static inputs for the sample webinar the fixture source generates (see fixtures.ts). */

import type { EngagementMarker, EngagementPoll } from "../api-types.ts";

export const SESSION_MIN = 60;
export const LOBBY_MIN = 10;
export const BUCKET_MIN = 5;
export const REGISTERED = 120;
export const ATTENDEES = 85;

export const WEBINAR = {
  slug: "scale-your-coaching-practice",
  title: "Scale your coaching practice without burning out",
  hostName: "Priya Sharma",
  timeZone: "Asia/Kolkata",
  startedAt: "2026-09-22T13:00:00Z",
  endedAt: "2026-09-22T14:00:00Z",
};

export const REACTIONS = ["👏", "👍", "❤️", "😂", "🎉", "😮"] as const;

export const MARKERS: EngagementMarker[] = [
  { minute: 8, kind: "poll", label: "Poll · Biggest challenge" },
  { minute: 19, kind: "quiz", label: "Quiz 1 · Pricing" },
  { minute: 31, kind: "poll", label: "Poll · Client count" },
  { minute: 37, kind: "quiz", label: "Quiz 2 · Retention" },
  { minute: 44, kind: "qa", label: "Q&A opens" },
  { minute: 53, kind: "offer", label: "Programme offer" },
];

export type PollDef = Omit<EngagementPoll, "votes" | "liveAtOpen">;

export const POLL_DEFS: PollDef[] = [
  {
    id: "p1",
    kind: "poll",
    minute: 8,
    question: "What's your biggest challenge right now?",
    options: ["Finding clients", "Pricing", "Time / burnout", "Systems & tools"],
  },
  {
    id: "q1",
    kind: "quiz",
    minute: 19,
    question: "Which pricing model scales best for 1:many coaching?",
    options: ["Hourly", "Package / programme", "Pay what you want"],
    correct: 1,
  },
  {
    id: "p2",
    kind: "poll",
    minute: 31,
    question: "How many paying clients do you have today?",
    options: ["0–5", "6–15", "16–30", "30+"],
  },
  {
    id: "q2",
    kind: "quiz",
    minute: 37,
    question: "What's the #1 driver of client retention?",
    options: ["Lower prices", "Visible early wins", "More content", "Longer calls"],
    correct: 1,
  },
];

export const FIRST = [
  "Aarav", "Ananya", "Rohan", "Meera", "Kabir", "Isha", "Vikram", "Neha", "Arjun", "Pooja",
  "Sanjay", "Divya", "Rahul", "Kavya", "Aditya", "Sneha", "Nikhil", "Riya", "Karan", "Tara",
  "Sarah", "James", "Emma", "Daniel", "Olivia", "Lucas", "Amara", "Yusuf", "Lena", "Mateo",
];

export const LAST = [
  "Mehta", "Iyer", "Kapoor", "Nair", "Reddy", "Gupta", "Shah", "Rao", "Menon", "Joshi",
  "Patel", "Das", "Bose", "Khan", "Singh", "Chen", "Okafor", "Müller", "Silva", "Brown",
];

export const GREETINGS = [
  "Hi everyone! Joining from Pune 👋",
  "Hello from Bengaluru!",
  "Good evening all 🙌",
  "Hi Priya! Excited for this",
];

export const CHAT_LINES = [
  "This is so relevant, thank you Priya",
  "Can you share the slides after?",
  "The packaging framework is gold",
  "I struggle with exactly this",
  "Taking notes 📝",
  "Audio is clear 👍",
  "What tool do you use for scheduling?",
  "Love the client-wins idea",
  "Is the recording going to be shared?",
  "Burnout is real 😅",
  "Great example!",
];

export const QUESTION_LINES = [
  "How do you price a group programme vs 1:1?",
  "What's a good first offer for a new coach?",
  "How many free sessions should I give?",
  "How do you handle clients who ghost after week 2?",
  "Which CRM do you recommend for solo coaches?",
  "Do webinars still convert in 2026?",
  "How long should a coaching programme run?",
  "How do I raise prices for existing clients?",
];
