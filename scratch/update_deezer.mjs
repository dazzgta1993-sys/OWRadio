import fs from 'node:fs';

function updateDeezer(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  const oldCode = `  // Prefer exact match (case insensitive) if available, otherwise take first
  const exact = data.data.find((a: any) => a.name.toLowerCase() === query.toLowerCase().trim());
  const artist = exact || data.data[0];`;

  const newCode = `  // Sort candidates by fan count so verified international artists take priority
  const sorted = [...data.data].sort((a: any, b: any) => (b.nb_fan || 0) - (a.nb_fan || 0));
  const exact = sorted.find((a: any) => a.name.toLowerCase() === query.toLowerCase().trim());
  const artist = exact || sorted[0];`;

  if (content.includes(oldCode)) {
    content = content.replace(oldCode, newCode);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Successfully updated', filePath);
  } else {
    // CRLF check
    const oldCodeCRLF = oldCode.replace(/\n/g, '\r\n');
    const newCodeCRLF = newCode.replace(/\n/g, '\r\n');
    if (content.includes(oldCodeCRLF)) {
      content = content.replace(oldCodeCRLF, newCodeCRLF);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Successfully updated (CRLF)', filePath);
    } else {
      console.error('Target not found in', filePath);
    }
  }
}

updateDeezer('src/services/deezer.ts');
updateDeezer('OWRADIO-DOCKER/src/services/deezer.ts');
