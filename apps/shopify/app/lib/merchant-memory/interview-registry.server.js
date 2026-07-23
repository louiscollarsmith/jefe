// @ts-check

export const INTERVIEW_STATUS = {
  notStarted: "not_started",
  inProgress: "in_progress",
  paused: "paused",
  completed: "completed",
  skipped: "skipped",
  failed: "failed",
};

export const INTERVIEW_TOPIC_STATUS = {
  open: "open",
  answered: "answered",
  partiallyAnswered: "partially_answered",
  unknown: "unknown",
  declined: "declined",
  notApplicable: "not_applicable",
};

export const INTERVIEW_TURN_STATUS = {
  pending: "pending",
  committed: "committed",
  clarificationRequired: "clarification_required",
  noMemoryChange: "no_memory_change",
  failed: "failed",
};

export const INTERVIEW_READINESS_THRESHOLD = 75;

export const INTERVIEW_TOPICS = [
  {
    topicKey: "business.description",
    beliefKey: "business.description",
    category: "business",
    label: "Business description",
    question: "How would you describe what your business sells, in your own words?",
    guidance: "Start low-friction. Let the merchant define the business naturally.",
    suggestions: ["Premium skincare", "Handmade gifts", "Specialist equipment"],
    priority: 10,
    weight: 20,
    required: true,
  },
  {
    topicKey: "customers.primary_customer_type",
    beliefKey: "customers.primary_customer_type",
    category: "customers",
    label: "Primary customer",
    question: "Who is your main customer?",
    guidance: "Ask for the merchant's aggregate customer type, not personal data.",
    suggestions: ["Gift buyers", "Repeat hobbyists", "Small businesses"],
    priority: 20,
    weight: 15,
    required: true,
  },
  {
    topicKey: "goals.primary_business_goal",
    beliefKey: "goals.primary_business_goal",
    category: "goals",
    label: "Primary business goal",
    question: "What would you most like Jefe to help improve first?",
    guidance: "Find the first useful outcome Jefe should optimise future recommendations around.",
    suggestions: ["Repeat purchases", "Profit", "New customer growth"],
    priority: 30,
    weight: 20,
    required: true,
  },
  {
    topicKey: "preferences.optimisation_priority",
    beliefKey: "preferences.optimisation_priority",
    category: "preferences",
    label: "Optimisation priority",
    question: "Should Jefe generally prioritise growth, profit, cash flow, retention, or something else?",
    guidance: "Resolve tradeoff preference into the controlled enum where possible.",
    suggestions: ["Growth", "Profit", "Cash flow"],
    priority: 40,
    weight: 15,
    required: true,
  },
  {
    topicKey: "marketing.primary_acquisition_channel",
    beliefKey: "marketing.primary_acquisition_channel",
    category: "marketing",
    label: "Primary acquisition channel",
    question: "Where do most new customers currently come from?",
    guidance: "Ask for the channel the merchant sees as most important today.",
    suggestions: ["Instagram", "Google", "Word of mouth"],
    priority: 50,
    weight: 10,
    required: true,
  },
  {
    topicKey: "operations.biggest_operational_pain",
    beliefKey: "operations.biggest_operational_pain",
    category: "operations",
    label: "Operational problem",
    question: "What is the biggest operational problem in the business right now?",
    guidance: "Capture the constraint without proposing a recommendation.",
    suggestions: ["Stock planning", "Fulfilment delays", "Supplier lead times"],
    priority: 60,
    weight: 10,
    required: true,
  },
  {
    topicKey: "policies.never_recommend",
    beliefKey: "policies.never_recommend",
    category: "policies",
    label: "Recommendations to avoid",
    question: "Are there any kinds of recommendations you would never want Jefe to make?",
    guidance: "Capture hard restrictions and keep observed facts separate from policy.",
    suggestions: ["No blanket discounts", "No preorder changes", "No brand-led changes"],
    priority: 70,
    weight: 10,
    required: false,
  },
];

export function getInterviewTopics() {
  return INTERVIEW_TOPICS;
}

/**
 * @param {string} topicKey
 */
export function getInterviewTopic(topicKey) {
  return INTERVIEW_TOPICS.find((topic) => topic.topicKey === topicKey) ?? null;
}

/**
 * @param {string} beliefKey
 */
export function getTopicForBeliefKey(beliefKey) {
  return INTERVIEW_TOPICS.find((topic) => topic.beliefKey === beliefKey) ?? null;
}
