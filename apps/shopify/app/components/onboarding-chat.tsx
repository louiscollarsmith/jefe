import { type FormEvent, useId } from "react";
import { Form } from "react-router";
import { BlockStack, Button, Text } from "@shopify/polaris";

export type OnboardingChatMessage = {
  id: string;
  role: "merchant" | "assistant";
  content: string;
};

type OnboardingChatHiddenField = {
  name: string;
  value: string;
};

type OnboardingChatProps = {
  messages: OnboardingChatMessage[];
  statusMessage?: string | null;
  statusActive?: boolean;
  intent: string;
  className?: string;
  hiddenFields?: OnboardingChatHiddenField[];
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  submitLoading?: boolean;
};

export function OnboardingChat({
  messages,
  statusMessage = null,
  statusActive = false,
  intent,
  className,
  hiddenFields = [],
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
  disabled = false,
  submitDisabled = false,
  submitLoading = false,
}: OnboardingChatProps) {
  const inputId = useId();
  const showMessages = messages.length > 0 || Boolean(statusMessage);

  return (
    <div className={`JefeOnboardingChat${className ? ` ${className}` : ""}`}>
      <BlockStack gap="300">
        {showMessages ? (
          <div className="JefeOnboardingChatMessages" aria-live="polite">
            {messages.map((item) => (
              <div
                key={item.id}
                className={`JefeOnboardingChatMessage is-${item.role}`}
              >
                <Text as="p">{item.content}</Text>
              </div>
            ))}
            {statusMessage ? (
              <div
                className={`JefeOnboardingChatMessage is-assistant ${
                  statusActive ? "is-thinking" : ""
                }`}
                role={statusActive ? "status" : undefined}
              >
                <Text as="p">{statusMessage}</Text>
              </div>
            ) : null}
          </div>
        ) : null}
        <Form method="post" className="JefeOnboardingChatForm" onSubmit={onSubmit}>
          <input type="hidden" name="intent" value={intent} />
          {hiddenFields.map((field) => (
            <input
              key={`${field.name}:${field.value}`}
              type="hidden"
              name={field.name}
              value={field.value}
            />
          ))}
          <div className="JefeOnboardingChatComposer">
            <div className="JefeOnboardingChatField">
              <label className="JefeOnboardingChatLabel" htmlFor={inputId}>
                {label}
              </label>
              <input
                id={inputId}
                className="JefeOnboardingChatInput"
                name="message"
                value={value}
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder={placeholder}
                autoComplete="off"
                disabled={disabled}
              />
            </div>
            <Button
              submit
              variant="primary"
              disabled={submitDisabled}
              loading={submitLoading}
            >
              Send
            </Button>
          </div>
        </Form>
      </BlockStack>
    </div>
  );
}
