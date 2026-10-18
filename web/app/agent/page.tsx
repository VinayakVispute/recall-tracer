"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

// The backend's typed message is RecallAgentUIMessage in ../src/agent/ai-agent.ts (not imported across packages).
type Part = UIMessage["parts"][number];
type ToolPart = Extract<Part, { type: `tool-${string}` | "dynamic-tool" }>;

const SUGGESTIONS = [
  "Search FDA for recent Class I recalls from a contaminated ingredient",
  "Trace lot L-204: which stores must pull the product and which are safe?",
  "Run the full recall for L-204 and draft the notices",
];

export default function Page() {
  const { messages, sendMessage, status, stop, error, addToolApprovalResponse } =
    useChat({
      transport: new DefaultChatTransport({ api: "/api/chat" }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });

  const respond = (id: string, approved: boolean) =>
    addToolApprovalResponse({ id, approved });

  const renderTool = (part: ToolPart, key: string) => {
    const header =
      part.type === "dynamic-tool" ? (
        <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
      ) : (
        <ToolHeader type={part.type} state={part.state} />
      );
    return (
      <div key={key} className="flex flex-col gap-2">
        <Tool>
          {header}
          <ToolContent>
            <ToolInput input={part.input} />
            <ToolOutput
              output={part.state === "output-available" ? part.output : undefined}
              errorText={part.state === "output-error" ? part.errorText : undefined}
            />
          </ToolContent>
        </Tool>
        {part.state !== "input-streaming" &&
          part.state !== "input-available" &&
          "approval" in part &&
          part.approval &&
          !part.approval.isAutomatic && (
            <Confirmation approval={part.approval} state={part.state}>
              <ConfirmationTitle>
                <ConfirmationRequest>
                  {part.approval.requestReason ?? "Approve drafting this recall notice?"}
                </ConfirmationRequest>
                <ConfirmationAccepted>Approved.</ConfirmationAccepted>
                <ConfirmationRejected>Denied.</ConfirmationRejected>
              </ConfirmationTitle>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => respond(part.approval!.id, false)}
                >
                  Deny
                </ConfirmationAction>
                <ConfirmationAction onClick={() => respond(part.approval!.id, true)}>
                  Approve
                </ConfirmationAction>
              </ConfirmationActions>
            </Confirmation>
          )}
      </div>
    );
  };

  return (
    <main className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-3xl flex-col gap-4 p-4">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 && (
            <ConversationEmptyState
              title="Ask about a lot or a recall"
              description="The agent answers from the traceability records, with the evidence behind each answer, and can look up real FDA recalls for comparison."
            />
          )}
          {messages.map((m, mi) => (
            <Message key={m.id} from={m.role}>
              <MessageContent>
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  if (part.type === "text")
                    return <MessageResponse key={key}>{part.text}</MessageResponse>;
                  if (part.type === "reasoning")
                    return (
                      <Reasoning
                        key={key}
                        isStreaming={
                          status === "streaming" &&
                          mi === messages.length - 1 &&
                          i === m.parts.length - 1
                        }
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    );
                  if (part.type === "dynamic-tool" || part.type.startsWith("tool-"))
                    return renderTool(part as ToolPart, key);
                  return null;
                })}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex flex-col gap-3">
        {messages.length === 0 && (
          <Suggestions>
            {SUGGESTIONS.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={(t) => sendMessage({ text: t })} />
            ))}
          </Suggestions>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
        <PromptInput onSubmit={({ text }) => {
          if (text.trim()) sendMessage({ text });
        }}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask about a lot or an FDA recall" maxLength={2000} />
          </PromptInputBody>
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} onStop={stop} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </main>
  );
}
