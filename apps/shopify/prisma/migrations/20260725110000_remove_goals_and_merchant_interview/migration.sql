-- Remove the retired Goals/interview workflow and old goal-specific memory rows.

UPDATE "merchant_memory_conversation_messages"
SET "related_open_question_id" = NULL
WHERE "related_open_question_id" IN (
  SELECT "id"
  FROM "merchant_memory_open_questions"
  WHERE "category" = 'goals'
     OR "question_key" IN ('goals.primary_business_goal', 'goals.current_priority')
);

DELETE FROM "merchant_memory_open_questions"
WHERE "category" = 'goals'
   OR "question_key" IN ('goals.primary_business_goal', 'goals.current_priority');

DELETE FROM "merchant_memory_belief_history"
WHERE "key" IN ('goals.primary_business_goal', 'goals.current_priority');

DELETE FROM "merchant_memory_beliefs"
WHERE "category" = 'goals'
   OR "key" IN ('goals.primary_business_goal', 'goals.current_priority');

DROP TABLE IF EXISTS "merchant_interview_messages" CASCADE;
DROP TABLE IF EXISTS "merchant_interview_turns" CASCADE;
DROP TABLE IF EXISTS "merchant_interview_topics" CASCADE;
DROP TABLE IF EXISTS "merchant_interviews" CASCADE;
