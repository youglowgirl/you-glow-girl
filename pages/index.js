// pages/index.js
// Serves the You Glow Girl HTML as the homepage.
// The serverless API routes in /pages/api/ handle backend calls.

import fs from 'fs';
import path from 'path';

export default function Home({ html }) {
  return (
    <div dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export async function getStaticProps() {
  const filePath = path.join(process.cwd(), 'public', 'index-static.html');
  const html = fs.readFileSync(filePath, 'utf8');
  // Strip the outer html/head/body tags so Next.js handles the document shell
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const content = bodyMatch ? bodyMatch[1] : html;
  return { props: { html: content } };
}
