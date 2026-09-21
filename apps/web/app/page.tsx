export default function HomePage() {
  return (
    <main>
      <h1>Stack Cloud</h1>
      <p className="lead">
        Keep your AI agent Skills reproducible across machines. Your Stack lives
        locally and syncs privately to the Cloud.
      </p>

      <h2>Get started</h2>
      <p className="muted">Sign in from your terminal:</p>
      <pre>
        <code>stack login</code>
      </pre>
      <p className="muted">Then back up your main Stack:</p>
      <pre>
        <code>stack push</code>
      </pre>

      <p style={{ marginTop: '2rem' }} className="muted">
        Authorizing a device? Continue to{' '}
        <a href="/cli">device authorization</a>.
      </p>
    </main>
  );
}
