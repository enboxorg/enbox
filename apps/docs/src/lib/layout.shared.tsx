import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export const gitConfig = {
  user: 'enboxorg',
  repo: 'docs',
  branch: 'main',
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-semibold tracking-tight text-[15px]">
          en<span className="font-bold">b</span>ox docs
        </span>
      ),
    },
    githubUrl: 'https://github.com/enboxorg/enbox',
    links: [
      {
        text: 'Guides',
        url: '/docs',
        active: 'nested-url',
      },
    ],
  };
}
