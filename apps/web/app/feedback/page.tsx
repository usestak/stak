import type { Metadata } from 'next';

import '../overview/shell.css';
import '../_components/public-landing-shell.css';

import { SiteFooter, SiteNav } from '../_components/site-chrome';
import { FeedbackForm } from './feedback-form';

export const metadata: Metadata = {
  title: 'Feedback',
  description:
    'Tell us what worked, what was confusing, or what you expected during the STAK Public Beta.',
};

export default function FeedbackPage() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
      />
      <div className="stak stak-landing">
        <SiteNav />
        <main id="main-content">
          <section
            className="stak-landing-section stak-feedback-section"
            aria-label="Feedback"
          >
            <div className="stak-feedback-intro">
              <span className="stak-landing-eyebrow">FEEDBACK</span>
              <h1 className="stak-feedback-h1">
                Help us make STAK easier to use.
              </h1>
              <p>Short and specific is perfect.</p>
            </div>
            <FeedbackForm />
          </section>
        </main>
        <SiteFooter />
      </div>
    </>
  );
}
