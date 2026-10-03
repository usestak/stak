import { redirect } from 'next/navigation';

import { SiteHeader } from '@/app/_components/site-header';
import { getUserStack, type WebStackDetail } from '@/lib/dashboard';
import { relativeTime, skillCount } from '@/lib/format';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardStackPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getSessionUser();
  if (!user)
    redirect(`/auth/login?next=/dashboard/${encodeURIComponent(slug)}`);

  let detail: WebStackDetail | null = null;
  let failed = false;
  try {
    detail = await getUserStack(user.id, slug);
  } catch {
    failed = true;
  }

  return (
    <>
      <SiteHeader user={user} />
      <div className="page">
        <main>
          {failed ? (
            <>
              <h1>{slug}</h1>
              <div className="notice">
                <p>Could not load this Stack.</p>
                <p className="muted">
                  <a href={`/dashboard/${slug}`}>Try again.</a>
                </p>
              </div>
            </>
          ) : !detail ? (
            <>
              <h1>Stack not found</h1>
              <p className="muted">
                This Stack is not in your Cloud.{' '}
                <a href="/dashboard">Back to your Stacks.</a>
              </p>
            </>
          ) : (
            <>
              <h1>{detail.name}</h1>
              <div className="meta">
                <span>{skillCount(detail.skillCount)}</span>
                {detail.cloudVersion != null ? (
                  <span className="dot">
                    Cloud version {detail.cloudVersion}
                  </span>
                ) : (
                  <span className="dot">Not pushed yet</span>
                )}
                {detail.updatedAt ? (
                  <span className="dot">
                    Updated {relativeTime(detail.updatedAt)}
                  </span>
                ) : null}
              </div>

              <h2>Skills</h2>
              {detail.skills.length === 0 ? (
                <p className="muted">
                  This Stack has no Skills yet. Run <code>stak push</code> from
                  your terminal.
                </p>
              ) : (
                <ul className="skills">
                  {detail.skills.map((skill) => (
                    <li key={skill.name}>
                      <div className="skill-name">{skill.name}</div>
                      {skill.description ? (
                        <div className="skill-desc">{skill.description}</div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}
