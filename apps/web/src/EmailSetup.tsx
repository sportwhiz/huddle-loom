import { useEffect, useState, type FormEvent } from "react";
import { api, bootstrapAuth } from "./auth-client";
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
        await bootstrapAuth(true);
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
        {automaticSender
          ? "Email is included with GoDaddy"
          : ready
            ? "Your Studio can send email"
            : "Set up email invitations"}
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
              ? "GoDaddy already handles email sending and chooses the sender address. You can email invitations now; no email password, API key, or custom domain is needed. The test below is optional and checks delivery to your inbox."
              : "Email invitations are available after you finish sender setup and confirm a test email. Use an address on a domain you control, such as whiteboard@yourdomain.com, not a Gmail or Outlook address."}
          </p>
          {!automaticSender && (
            <p>
              You can invite people now with a private link under Administration
              → Invitations. Copy the link and send it yourself by email or chat.
            </p>
          )}
          {!automaticSender && available && (
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
              <li>
                Enter that code here to enable email invitations and account
                messages.
              </li>
            </ol>
          )}
          {!available ? (
            <p>
              This installation’s email connection is unavailable. Check its
              hosting configuration or update the installation before sending a
              test. Private invitation links are available now.
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
                {attempt
                  ? automaticSender
                    ? "Confirm test delivery"
                    : "Confirm and enable email"
                  : automaticSender
                    ? "Send optional test email"
                    : "Send test email"}
              </Submit>
              {attempt && (
                <p>
                  Check your inbox and spam folder for the six-digit code. It
                  expires after 15 minutes.
                </p>
              )}
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
