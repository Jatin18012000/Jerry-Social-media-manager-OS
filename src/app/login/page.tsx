import { LoginForm } from './controls';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const params = await searchParams;

  return (
    <main>
      <h1>Social Media OS</h1>

      {params.reason === 'unconfigured' ? (
        <section className="panel">
          <p className="error">
            <strong>Not configured.</strong> Set <code>SESSION_SECRET</code>{' '}
            (32+ characters) and <code>APP_PASSPHRASE</code> in{' '}
            <code>.env.local</code>, then restart.
          </p>
          <p className="muted small">
            The app binds to the local network so an iPad can reach it, which
            means every device on that network can too. It refuses to run
            without a passphrase rather than sitting open (§41).
          </p>
        </section>
      ) : (
        <section className="panel">
          <LoginForm next={params.next ?? '/'} />
        </section>
      )}
    </main>
  );
}
