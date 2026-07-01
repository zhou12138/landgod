import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'LandGod Worker',
    executableName: 'landgod', // 设置输出的二进制文件名
    dir: '.',
    extraResource: [
      './mcp-servers',
    ],
    ignore: [
      // Exclude bundled MCP servers from asar (they are in extraResource)
      /^\/mcp-servers$/,
    ],
  },
  makers: [
    new MakerSquirrel({ name: 'cli-server', authors: 'CLI Server' }),
    new MakerDMG({ format: 'ULFO' }),
    new MakerDeb({ options: { name: 'landgod', bin: 'landgod' } }),
    new MakerRpm({ options: { name: 'landgod', bin: 'landgod', license: 'MIT' } }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
