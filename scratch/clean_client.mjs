import fs from 'node:fs';

function cleanClient(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Remove features and filter imports
  content = content.replace(/import \{[^}]*stationCommand[^}]*\} from '\.\/commands\/features\.js';/gs, '');
  content = content.replace(/import \{[^}]*filterCommand[^}]*\} from '\.\/commands\/filter\.js';/gs, '');

  // Clean ALL_COMMANDS array
  const oldCommands = `const ALL_COMMANDS = [
  playCommand,     // /play <query>
  vibeCommand,     // /vibe <prompt>
  controlCommand,  // /control <skip|pause|resume|replay|queue|clear|shuffle|remove|volume|status|history|like|dislike>
  stationCommand,  // /station <preset|throwback|morph|filter|artist>
  tasteCommand,    // /taste <profile|playlist|artists|genres|clear|veto>
  joinCommand,     // /join
  leaveCommand,    // /leave
];`;

  const newCommands = `const ALL_COMMANDS = [
  playCommand,     // /play <query>
  controlCommand,  // /control <skip|pause|resume|replay|queue|clear|shuffle|remove|volume|status|history|like|dislike>
  joinCommand,     // /join
  leaveCommand,    // /leave
];`;

  if (content.includes(oldCommands)) {
    content = content.replace(oldCommands, newCommands);
  } else {
    content = content.replace(oldCommands.replace(/\n/g, '\r\n'), newCommands.replace(/\n/g, '\r\n'));
  }

  // Remove station, taste, filter cases from switch
  content = content.replace(/case 'station': \{[\s\S]*?break;\s*\}/g, '');
  content = content.replace(/case 'taste':\s*await handleTaste\([^)]+\);\s*break;/g, '');
  content = content.replace(/case 'filter':\s*await handleFilterCommand\([^)]+\);\s*break;/g, '');
  content = content.replace(/case 'throwback':\s*await handleThrowback\([^)]+\);\s*break;/g, '');
  content = content.replace(/case 'radio':\s*await handleRadio\([^)]+\);\s*break;/g, '');
  content = content.replace(/case 'morph':\s*await handleMorph\([^)]+\);\s*break;/g, '');
  content = content.replace(/case 'veto':\s*await handleVeto\([^)]+\);\s*break;/g, '');
  content = content.replace(/case 'artist':\s*await handleArtist\([^)]+\);\s*break;/g, '');

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Cleaned', filePath);
}

cleanClient('src/bot/client.ts');
cleanClient('OWRADIO-DOCKER/src/bot/client.ts');
