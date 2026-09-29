/* Fixture survey data for the dev-bypass host pages and the screenshot harness. Shaped exactly
 * like the API's responses so the real components render it. */

import type { HostSurvey, SurveyResults } from "./api-types";

export const FIXTURE_HOST_SURVEY: HostSurvey = {
  attended: 48,
  survey: {
    id: "fixture-survey",
    mode: "builtin",
    title: "How was today's session?",
    buttonLabel: "",
    externalUrl: "",
    askRating: true,
    status: "live",
    sendAt: "on_end",
    sendAfterMin: 0,
    launchedAt: "2026-09-27T16:02:00Z",
    updatedAt: "2026-09-27T16:02:00Z",
    responses: 31,
    linkClicks: 0,
    locked: true,
    questions: [
      { id: "q-nps", kind: "nps_10", prompt: "How likely are you to recommend this session to a friend or colleague?", required: false, options: [] },
      { id: "q-pace", kind: "single_choice", prompt: "How was the pace?", required: false, options: ["Too slow", "Just right", "Too fast"] },
      { id: "q-more", kind: "text", prompt: "What could be improved?", required: false, options: [] },
    ],
  },
};

export const FIXTURE_SURVEY_RESULTS: SurveyResults = {
  configured: true,
  mode: "builtin",
  status: "live",
  title: "How was today's session?",
  launchedAt: "2026-09-27T16:02:00Z",
  attended: 48,
  responses: 31,
  responseRatePct: 65,
  linkClicks: 0,
  clickThroughPct: 0,
  ratings: 31,
  averageRating: 4.4,
  ratingDistribution: [0, 1, 3, 9, 18],
  nps: { score: 42, promoters: 16, passives: 8, detractors: 3, responses: 27 },
  questions: [
    {
      id: "q-nps",
      kind: "nps_10",
      prompt: "How likely are you to recommend this session to a friend or colleague?",
      answered: 27,
      average: 8.4,
      distribution: [0, 0, 0, 1, 0, 1, 1, 3, 5, 7, 9],
      nps: { score: 42, promoters: 16, passives: 8, detractors: 3, responses: 27 },
    },
    {
      id: "q-pace",
      kind: "single_choice",
      prompt: "How was the pace?",
      answered: 29,
      average: -1,
      distribution: [3, 22, 4],
      choices: [
        { label: "Too slow", count: 3 },
        { label: "Just right", count: 22 },
        { label: "Too fast", count: 4 },
      ],
    },
    { id: "q-more", kind: "text", prompt: "What could be improved?", answered: 12, average: -1, distribution: [] },
  ],
  comments: [
    { questionId: "q-more", prompt: "What could be improved?", name: "Priya S.", text: "More time for Q&A at the end — the questions were the best part.", submittedAt: "2026-09-27T16:05:10Z" },
    { questionId: "q-more", prompt: "What could be improved?", name: "Marcus L.", text: "Share the slides before the session so we can follow along.", submittedAt: "2026-09-27T16:04:31Z" },
    { questionId: "q-more", prompt: "What could be improved?", name: "Aiko T.", text: "The live demo was great. A recording link afterwards would help.", submittedAt: "2026-09-27T16:03:48Z" },
  ],
};
