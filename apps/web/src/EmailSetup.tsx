import { useEffect, useState, type FormEvent } from "react";
import { api } from "./auth-client";
import { Field, Feedback, Submit, StepUp } from "./auth-ui";

export function EmailSetup({ onReady }: { onReady?: () => void }) {
  const [sender, setSender] = useState(""),
    [recipient, setRecipient] = useState("");
  const [code, setCode] = useState(""),
    [attempt, setAttempt] = useState("");
  const [automaticSender, setAutomaticSender] = useState(false);
  const [managed, setManaged] = useState(false),
    [ready, setReady] = useState(false),
    [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stepUp, setStepUp] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{
      sender: string;
      recipient: string;
      confirmed: boolean;
      available: boolean;
      managed: boolean;
      automaticSender?: boolean;
    }>("/api/v1/installation/email")
      .then((value) => {
        if (live) {
          setManaged(value.managed);
          setAutomaticSender(Boolean(value.automaticSender));
          setSender(value.sender);
          setRecipient(value.recipient);
          setReady(value.confirmed);
          setAvailable(value.available);
        }
      })
      .catch((failure) => {
        if (live) {
          setError(failure.message);
          if (failure.code === "STEP_UP_REQUIRED") setStepUp(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (attempt) {
        await api("/api/v1/installation/email/confirm", { attempt, code });
        setReady(true);
        onReady?.();
      } else {
        const value = await api<{ attempt: string }>(
          "/api/v1/installation/email/test",
          { sender, recipient },
        );
        setAttempt(value.attempt);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Email setup could not be completed.",
      );
      if ((failure as { code?: string }).code === "STEP_UP_REQUIRED")
        setStepUp(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="identity-email-setup" aria-label="Studio email">
      <h2>
        {ready ? "Your Studio can send email" : "Connect your Studio’s email"}
      </h2>
      {ready ? (
        <>
          <p>
            {automaticSender ? (
              "GoDaddy handles the sender for your invitations and account emails."
            ) : (
              <>
                Invitations and account emails will be sent from{" "}
                <strong>{sender}</strong>.
              </>
            )}
          </p>
          {managed ? (
            <p>
              {automaticSender
                ? "Delivery to your test inbox has been confirmed."
                : "Email is managed by this deployment’s configuration."}
            </p>
          ) : (
            <button
              type="button"
              className="identity-link"
              onClick={() => {
                setReady(false);
                setAttempt("");
              }}
            >
              Change sender
            </button>
          )}
        </>
      ) : (
        <>
          <p>
            {automaticSender
              ? "Your hosting includes email sending. Send a test to your inbox to make sure invitations and account emails arrive."
              : "Send invitations and help people recover their accounts. Use a sender on a domain you own."}{" "}
            You can finish this later and invite people with private links in
            the meantime.
          </p>
          {!automaticSender && (
            <ol>
              <li>
                <a
                  href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Enable Email Sending in Cloudflare
                </a>
                . Select your domain and approve the automatic setup. A Workers
                Paid plan is required for general sending.
              </li>
              <li>
                Enter your sender and your own inbox below. We’ll send a code to
                check delivery.
              </li>
            </ol>
          )}
          {!available ? (
            <p>
              Update Open Whiteboard to include its email connection before
              continuing.
            </p>
          ) : (
            <form onSubmit={submit}>
              {attempt ? (
                <Field
                  label="Code from your test email"
                  name="email-test-code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={code}
                  onChange={setCode}
                />
              ) : (
                <>
                  {!automaticSender && (
                    <Field
                      label="Send emails from"
                      name="studio-sender"
                      type="email"
                      value={sender}
                      onChange={setSender}
                      hint="For example, whiteboard@yourdomain.com"
                    />
                  )}
                  <Field
                    label="Your inbox for the test"
                    name="studio-email-test"
                    type="email"
                    value={recipient}
                    onChange={setRecipient}
                  />
                </>
              )}
              <Submit busy={busy}>
                {attempt ? "Confirm email works" : "Send test email"}
              </Submit>
              {attempt && (
                <button
                  type="button"
                  className="identity-link"
                  onClick={() => {
                    setAttempt("");
                    setCode("");
                  }}
                >
                  {automaticSender
                    ? "Send another test"
                    : "Change addresses or send again"}
                </button>
              )}
            </form>
          )}
        </>
      )}
      <Feedback error={error} />
      {stepUp && (
        <StepUp
          onComplete={() => {
            setStepUp(false);
            setError("");
          }}
          onCancel={() => setStepUp(false)}
        />
      )}
    </section>
  );
}
