export const SAMPLE_HOUSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 400">
<path d="M80 330 L80 180 L250 60 L420 180 L420 330 Z" fill="none" stroke="black" stroke-width="6"/>
<path d="M200 330 L200 240 L300 240 L300 330" fill="none" stroke="black" stroke-width="6"/>
<circle cx="250" cy="150" r="26" fill="none" stroke="black" stroke-width="5"/>
<path d="M330 330 L330 250 L400 250 L400 330" fill="none" stroke="black" stroke-width="5"/>
<line x1="40" y1="330" x2="460" y2="330" stroke="black" stroke-width="6"/>
<path d="M120 120 L150 90 L180 120" fill="none" stroke="black" stroke-width="4"/>
</svg>`

export const SAMPLE_ROCKET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">
<path d="M250 40 C 310 110, 330 200, 250 300 C 170 200, 190 110, 250 40 Z" fill="none" stroke="black" stroke-width="6"/>
<circle cx="250" cy="150" r="24" fill="none" stroke="black" stroke-width="5"/>
<path d="M190 230 L150 300 L195 290 Z" fill="none" stroke="black" stroke-width="5"/>
<path d="M310 230 L350 300 L305 290 Z" fill="none" stroke="black" stroke-width="5"/>
<path d="M230 300 L230 350 M250 310 L250 370 M270 300 L270 350" stroke="black" stroke-width="5" fill="none"/>
<path d="M120 420 Q 250 390 380 420" fill="none" stroke="black" stroke-width="5"/>
<path d="M90 120 L130 130 M100 170 L140 165" stroke="black" stroke-width="4"/>
</svg>`

export const SAMPLE_HELLO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 260">
<path d="M40 200 L40 60 M40 130 L110 130 M110 200 L110 60" fill="none" stroke="black" stroke-width="10" stroke-linecap="round"/>
<path d="M150 160 Q 150 80 200 80 Q 250 80 250 160 Q 250 200 200 200 Q 150 200 150 160 M250 160 Q 250 80 300 80 Q 350 80 350 160 L350 200" fill="none" stroke="black" stroke-width="10" stroke-linecap="round"/>
<path d="M390 200 L390 60 M390 200 L460 200 M390 120 L440 120" fill="none" stroke="black" stroke-width="10" stroke-linecap="round"/>
<path d="M490 80 Q 540 80 540 130 Q 540 160 490 160 L540 200" fill="none" stroke="black" stroke-width="10" stroke-linecap="round"/>
</svg>`

export const SAMPLES: { name: string; svg: string }[] = [
  { name: 'House', svg: SAMPLE_HOUSE },
  { name: 'Rocket', svg: SAMPLE_ROCKET },
  { name: 'Hello', svg: SAMPLE_HELLO },
]
