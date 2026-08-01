/**
 * Loco Lift — user-interface language.
 *
 * San Viejo is a Puerto Rican port city, and the game's chrome is bilingual
 * because the island is: signage, radio and conversation switch between Spanish
 * and English mid-sentence without anyone noticing. `both` is therefore the
 * default and the designed-for look — a Spanish headline with a smaller English
 * gloss under or beside it. `es` and `en` exist for players who want one clean
 * language, not as an afterthought: every screen renders correctly in all three.
 *
 * ## How switching works, and why it costs nothing
 *
 * Two mechanisms, chosen per string:
 *
 *  1. **Static pairs** (`bi`, `hint`) emit *both* languages into the DOM once,
 *     each in an element carrying a real `lang` attribute, and the stylesheet
 *     hides the unwanted one off `[data-lang]` on the UI root. Switching those
 *     is a single attribute write with no DOM churn and no JS at all — and the
 *     `lang` attributes are correct for screen readers and hyphenation whether
 *     or not anything is hidden.
 *  2. **Composed or dynamic strings** (aria labels, counted nouns, toast text)
 *     register a render callback through `bind`/`onChange`, which re-runs on a
 *     mode change. Only these allocate, and only when the player flips the
 *     setting.
 *
 * ## What is deliberately *not* here
 *
 * Passenger dialogue. Characters code-switch — "Mira, dale, I'm late" — and that
 * is characterisation, not chrome. `passenger:say` text is authored per line and
 * passes through untouched in every mode. The settings row says so, so nobody
 * files it as a bug.
 *
 * Text emitted by gameplay systems outside `src/ui` (`ui:toast` / `ui:notice`
 * payloads from the mission, story and challenge modules) also passes through
 * verbatim: the UI renders what it is handed. Those modules would need to route
 * their own strings through this table to become switchable.
 *
 * ART_REFERENCE §7.1 governs the Spanish: correct accents, inverted opening
 * punctuation, real Puerto Rican register — `carrera` for a fare, `guagua` for a
 * bus, `chinchorro`, `¡Brutal!`. Nothing machine-translated.
 */

/* ------------------------------------------------------------------ table */

export type LangMode = 'both' | 'es' | 'en';

interface Phrase {
  readonly es: string;
  readonly en: string;
}

/**
 * Every user-facing string in `src/ui`, keyed `screen.thing`.
 *
 * Spanish is written first because it is the primary language of the fiction;
 * the English is a real translation, not a gloss of the Spanish word order.
 */
export const STRINGS = {
  /* ---------------------------------------------------------------- HUD */
  'hud.fare': { es: 'TARIFA', en: 'Fare' },
  'hud.time': { es: 'TIEMPO', en: 'Time' },
  'hud.combo': { es: 'COMBO', en: 'Combo' },
  'hud.dropoff': { es: 'DESTINO', en: 'Drop-off' },
  'hud.patience': { es: 'PACIENCIA', en: 'Patience' },
  'hud.boost': { es: 'TURBO', en: 'Boost' },
  /** Gearbox readout on the tachometer. In PR a gear is *un cambio*. */
  'hud.gear': { es: 'CAMBIO', en: 'Gear' },
  /** The carriage has no gearbox — a horse has *aires*, its gaits. */
  'hud.gait': { es: 'AIRE', en: 'Gait' },
  'hud.redline': { es: 'CORTE', en: 'Redline' },
  'hud.go': { es: '¡DALE!', en: 'GO!' },
  'hud.timeExtended': { es: 'TIEMPO EXTRA', en: 'Time extended' },
  'hud.reason.delivery': { es: 'ENTREGA', en: 'Drop-off' },
  'hud.speed': { es: 'VELOCIDAD', en: 'Speed' },
  'hud.aria.fare': { es: 'Tarifa acumulada', en: 'Fare total' },
  'hud.aria.time': { es: 'Tiempo restante', en: 'Time remaining' },
  'hud.aria.speed': { es: 'Velocímetro', en: 'Speedometer' },
  'hud.aria.boost': { es: 'Carga del turbo', en: 'Boost charge' },
  'hud.aria.patience': { es: 'Paciencia del pasajero', en: 'Passenger patience' },
  'hud.aria.passenger': { es: 'Pasajero actual', en: 'Current passenger' },
  'hud.aria.combo': { es: 'Multiplicador de combo', en: 'Combo multiplier' },

  /* gaits, for the carriage tachometer */
  'gait.walk': { es: 'PASO', en: 'Walk' },
  'gait.trot': { es: 'TROTE', en: 'Trot' },
  'gait.canter': { es: 'GALOPE', en: 'Canter' },
  'gear.reverse': { es: 'R', en: 'R' },
  'gear.neutral': { es: 'N', en: 'N' },

  /* moods -------------------------------------------------------------- */
  'mood.calm': { es: 'TRANQUILO', en: 'Calm' },
  'mood.happy': { es: 'CONTENTO', en: 'Happy' },
  'mood.thrilled': { es: 'EUFÓRICO', en: 'Thrilled' },
  'mood.nervous': { es: 'NERVIOSO', en: 'Nervous' },
  'mood.furious': { es: 'FURIOSO', en: 'Furious' },
  'mood.terrified': { es: 'ATERRADO', en: 'Terrified' },

  /* ------------------------------------------------------------- title */
  'title.aria': { es: 'Menú principal de Loco Lift', en: 'Loco Lift main menu' },
  'title.tagline': {
    es: 'Taxi de aventura — 90 segundos, todo el casco viejo',
    en: 'Arcade taxi — 90 seconds, the whole old city',
  },
  'title.place': { es: 'SAN VIEJO', en: 'SAN VIEJO' },
  'title.country': { es: 'PUERTO RICO', en: 'PUERTO RICO' },
  'title.bank': { es: 'BANCO', en: 'Bank' },
  'title.modes': { es: 'Modos de juego', en: 'Game modes' },

  'mode.arcade': { es: 'TURNO ARCADE', en: 'Arcade Shift' },
  'mode.arcade.hint': {
    es: '90 s · cada carrera suma tiempo',
    en: '90 s · every fare buys you more',
  },
  'mode.freeRide': { es: 'PASEO LIBRE', en: 'Free Ride' },
  'mode.freeRide.hint': { es: 'Sin reloj · aprende los atajos', en: 'No clock · learn the shortcuts' },
  'mode.story': { es: 'HISTORIA', en: 'Story' },
  'mode.story.hint': { es: 'Doce encargos por el casco viejo', en: 'Twelve jobs across the old city' },
  'mode.challenge': { es: 'RETOS', en: 'Challenge' },
  'mode.challenge.hint': {
    es: 'Derrapes, saltos y contrarreloj',
    en: 'Drifts, jumps and time trials',
  },

  'title.garage': { es: 'GARAJE', en: 'Garage' },
  'title.garage.hint': { es: 'Pinta y equipa tu Jeep', en: 'Paint and kit out your Jeep' },
  'title.settings': { es: 'CONFIGURACIÓN', en: 'Settings' },
  'title.settings.hint': {
    es: 'Gráficos, audio y accesibilidad',
    en: 'Graphics, audio and accessibility',
  },
  'title.credits': { es: 'CRÉDITOS', en: 'Credits' },
  'title.credits.hint': { es: 'Quién construyó esto', en: 'Who built this' },

  'nav.navigate': { es: 'Navegar', en: 'Navigate' },
  'nav.select': { es: 'Seleccionar', en: 'Select' },
  'nav.back': { es: 'Volver', en: 'Back' },
  'nav.gamepad': { es: 'Mando', en: 'Gamepad' },
  'nav.close': { es: 'Cerrar', en: 'Close' },

  /* garage --------------------------------------------------------------- */
  'garage.body': { es: 'Color de carrocería', en: 'Body colour' },
  'garage.accent': { es: 'Color de acento', en: 'Accent colour' },
  'garage.livery': { es: 'Librea', en: 'Livery' },
  'garage.rims': { es: 'Llantas', en: 'Rims' },
  'garage.fares': { es: 'Carreras', en: 'Fares' },
  'garage.bestCombo': { es: 'Mejor combo', en: 'Best combo' },
  'garage.longestDrift': { es: 'Derrape más largo', en: 'Longest drift' },
  'garage.longestAir': { es: 'Vuelo más largo', en: 'Longest air' },

  /* credits -------------------------------------------------------------- */
  'credits.game.h': { es: 'LOCO LIFT', en: 'LOCO LIFT' },
  'credits.game.1': {
    es: 'Un taxi arcade en San Viejo, Puerto Rico.',
    en: 'An arcade taxi in San Viejo, Puerto Rico.',
  },
  'credits.game.2': {
    es: 'Motor: Three.js · Rapier3D · TypeScript · Vite.',
    en: 'Engine: Three.js · Rapier3D · TypeScript · Vite.',
  },
  'credits.built.h': { es: 'Construido por', en: 'Built by' },
  'credits.built.1': {
    es: 'Mundo, vehículo, cámara, tráfico, pasajeros, audio, efectos e interfaz — sistemas independientes sobre un bus de eventos tipado.',
    en: 'World, vehicle, camera, traffic, passengers, audio, effects and interface — independent systems over a typed event bus.',
  },
  'credits.built.2': {
    es: 'Toda la geometría y todas las texturas son procedurales. Cero descargas.',
    en: 'Every mesh and every texture is procedural. Nothing is downloaded.',
  },
  'credits.city.h': { es: 'Sobre la ciudad', en: 'About the city' },
  'credits.city.1': {
    es: 'San Viejo es una ciudad inventada, hecha de todo lo que el Viejo San Juan tiene de verdad: adoquín azul, garitas, balcones de hierro y más de cuatrocientas fachadas históricas.',
    en: 'San Viejo is invented, and made of everything Old San Juan genuinely has: blue cobblestone, garitas, iron balconies and four hundred-odd historic façades.',
  },
  'credits.city.2': {
    es: 'La arquitectura, los adoquines y los rótulos siguen referencias reales. Cualquier error es nuestro.',
    en: 'The architecture, the cobbles and the signage follow real references. Any mistake is ours.',
  },
  'credits.thanks.h': { es: 'Gracias', en: 'Thanks' },
  'credits.thanks.1': {
    es: 'A quien maneja despacio por la Calle del Cristo. Aquí no.',
    en: 'To everyone who drives slowly down Calle del Cristo. Not here.',
  },

  /* -------------------------------------------------------------- pause */
  'pause.title': { es: 'PAUSA', en: 'Paused' },
  'pause.resume': { es: 'CONTINUAR', en: 'Resume' },
  'pause.restart': { es: 'REINICIAR TURNO', en: 'Restart shift' },
  'pause.settings': { es: 'CONFIGURACIÓN', en: 'Settings' },
  'pause.quit': { es: 'SALIR AL TÍTULO', en: 'Quit to title' },
  'pause.hint': { es: 'para seguir manejando', en: 'to keep driving' },
  'pause.bestCombo': { es: 'COMBO MÁX', en: 'Best combo' },
  'pause.fares': { es: 'CARRERAS', en: 'Fares' },

  /* ------------------------------------------------------------ results */
  'results.title': { es: 'FIN DEL TURNO', en: 'Shift complete' },
  'results.base': { es: 'TARIFA BASE', en: 'Base fares' },
  'results.distance': { es: 'DISTANCIA', en: 'Distance' },
  'results.timeBonus': { es: 'TIEMPO', en: 'Time bonus' },
  'results.comboBonus': { es: 'COMBO', en: 'Combo bonus' },
  'results.tips': { es: 'PROPINAS', en: 'Tips' },
  'results.total': { es: 'TOTAL', en: 'Total' },
  'results.fares': { es: 'CARRERAS', en: 'Fares' },
  'results.bestCombo': { es: 'MEJOR COMBO', en: 'Best combo' },
  'results.banked': { es: 'AL BANCO', en: 'Banked' },
  'results.bankTotal': { es: 'BANCO TOTAL', en: 'Bank total' },
  'results.record': { es: '¡RÉCORD!', en: 'RECORD!' },
  'results.again': { es: 'OTRO TURNO', en: 'Drive again' },
  'results.garage': { es: 'GARAJE', en: 'Garage' },
  'results.titleBtn': { es: 'TÍTULO', en: 'Title' },
  'results.hintAgain': { es: 'para volver a la calle', en: 'back out on the street' },
  'results.hintTitle': { es: 'al título', en: 'to the title' },
  'results.aria': { es: 'Resultados del turno', en: 'Shift results' },
  'results.fare.one': { es: 'carrera', en: 'fare' },
  'results.fare.many': { es: 'carreras', en: 'fares' },
  'record.bestScore': { es: 'Mejor puntuación', en: 'Best score' },
  'record.mostFares': { es: 'Más carreras', en: 'Most fares' },
  'record.bestCombo': { es: 'Combo más alto', en: 'Highest combo' },

  'grade.5': { es: '¡Brutal!', en: 'Brutal!' },
  'grade.4': { es: '¡Tremendo!', en: 'Tremendous!' },
  'grade.3': { es: 'Bien hecho', en: 'Nicely done' },
  'grade.2': { es: 'Se puede mejorar', en: 'Room to improve' },
  'grade.1': { es: 'Ay, bendito', en: 'Ay, bendito' },

  /* ----------------------------------------------------------- settings */
  'settings.title': { es: 'CONFIGURACIÓN', en: 'Settings' },
  'settings.note': {
    es: 'Los cambios se aplican y se guardan al instante.',
    en: 'Changes apply and save instantly.',
  },
  'settings.reset': { es: 'Restaurar valores', en: 'Reset all' },
  'settings.groups': { es: 'Grupos de ajustes', en: 'Settings groups' },
  'group.general': { es: 'GENERAL', en: 'General' },
  'group.access': { es: 'ACCESIBILIDAD', en: 'Accessibility' },
  'group.graphics': { es: 'GRÁFICOS', en: 'Graphics' },
  'group.audio': { es: 'AUDIO', en: 'Audio' },
  'group.controls': { es: 'CONTROLES', en: 'Controls' },

  'set.language': { es: 'Idioma', en: 'Language' },
  'set.language.hint': {
    es: 'AMBOS muestra el español con el inglés debajo, como los rótulos de la ciudad. Lo que dicen los pasajeros no cambia: hablan como se habla aquí.',
    en: 'BOTH shows Spanish with English beneath it, the way the city signs it. Passenger dialogue never changes: they talk the way people talk here.',
  },
  'lang.both': { es: 'AMBOS', en: 'Both' },
  'lang.es': { es: 'ESPAÑOL', en: 'Spanish' },
  'lang.en': { es: 'INGLÉS', en: 'English' },

  'settings.accessIntro': {
    es: 'Estos ajustes cambian cómo se siente el juego, no cuánto vale. Nada de aquí te penaliza.',
    en: 'These change how the game feels, never what it scores. Nothing here penalises you.',
  },

  'set.screenShake': { es: 'Vibración de pantalla', en: 'Screen shake' },
  'set.screenShake.hint': {
    es: 'Cuánto sacude la cámara en choques y a alta velocidad.',
    en: 'How hard the camera kicks on impacts and at speed.',
  },
  'set.cameraSway': { es: 'Balanceo de cámara', en: 'Camera sway' },
  'set.cameraSway.hint': {
    es: 'El cabeceo y el balanceo de la cámara al derrapar.',
    en: 'The pitch and roll of the camera through a drift.',
  },
  'set.photo': { es: 'Modo fotosensible', en: 'Photosensitive safe' },
  'set.photo.hint': {
    es: 'Suprime relámpagos, destellos y parpadeos de la interfaz.',
    en: 'Suppresses lightning, flashes and every strobing UI effect.',
  },
  'set.colorBlind': { es: 'Daltonismo', en: 'Colour-blind mode' },
  'set.colorBlind.hint': {
    es: 'Reajusta los colores de juego (destino, pasajero, combo) para que no se confundan entre sí.',
    en: 'Re-tunes the gameplay colours — destination, pickup, combo — so no two can be confused.',
  },
  'cb.none': { es: 'Ninguno', en: 'None' },
  'set.subtitles': { es: 'Subtítulos', en: 'Subtitles' },
  'set.subtitles.hint': {
    es: 'Muestra lo que dicen los pasajeros al pie de la pantalla.',
    en: 'Shows what your passengers say along the bottom of the screen.',
  },
  'set.largeText': { es: 'Texto grande', en: 'Large text' },
  'set.largeText.hint': {
    es: 'Aumenta el tamaño de toda la tipografía de la interfaz.',
    en: 'Increases every type size across the interface.',
  },
  'set.contrast': { es: 'Alto contraste', en: 'High-contrast HUD' },
  'set.contrast.hint': {
    es: 'Fondos opacos y bordes más gruesos en el HUD.',
    en: 'Opaque panels and thicker keylines on the HUD.',
  },
  'set.boostInput': { es: 'Turbo', en: 'Boost input' },
  'set.boostInput.hint': {
    es: 'Mantener pulsado, o pulsar una vez para encender y otra para apagar.',
    en: 'Hold it down, or tap once on and once off.',
  },
  'opt.hold': { es: 'Mantener', en: 'Hold' },
  'opt.toggle': { es: 'Alternar', en: 'Toggle' },
  'set.assist': { es: 'Asistencia de dirección', en: 'Steering assist' },
  'set.assist.hint': {
    es: 'Contra-dirección automática al derrapar. Más alto = más perdona.',
    en: 'Automatic counter-steer through a slide. Higher is more forgiving.',
  },
  'set.autoAccel': { es: 'Acelerador automático', en: 'Auto-accelerate' },
  'set.autoAccel.hint': {
    es: 'El carro acelera solo; tú frenas y guías.',
    en: 'The car throttles itself; you brake and steer.',
  },
  'set.uiScale': { es: 'Tamaño de la interfaz', en: 'UI scale' },
  'set.uiScale.hint': { es: 'Escala todo el HUD y los menús.', en: 'Scales the whole HUD and every menu.' },

  'set.quality': { es: 'Calidad', en: 'Quality preset' },
  'set.quality.hint': {
    es: 'Cambiar el preajuste reescribe las opciones de abajo.',
    en: 'Changing the preset rewrites the options below.',
  },
  'q.low': { es: 'Baja', en: 'Low' },
  'q.medium': { es: 'Media', en: 'Medium' },
  'q.high': { es: 'Alta', en: 'High' },
  'q.ultra': { es: 'Ultra', en: 'Ultra' },
  'set.renderScale': { es: 'Escala de render', en: 'Render scale' },
  'set.renderScale.hint': {
    es: 'Renderiza por debajo de la resolución de pantalla y reescala.',
    en: 'Renders below display resolution and upscales.',
  },
  'set.shadows': { es: 'Sombras', en: 'Shadows' },
  'set.shadows.hint': {
    es: 'Sombras del sol en cascada. Lo más caro del cuadro.',
    en: 'Cascaded sun shadows. The most expensive thing in the frame.',
  },
  'set.post': { es: 'Post-procesado', en: 'Post-processing' },
  'set.post.hint': {
    es: 'Cadena completa: tono, grano, viñeta, aberración.',
    en: 'The full chain: tone map, grain, vignette, aberration.',
  },
  'set.bloom': { es: 'Resplandor', en: 'Bloom' },
  'set.bloom.hint': {
    es: 'Halo en las luces y en el brillo del turbo.',
    en: 'Halo around lights and the glow off the boost.',
  },
  'set.motionBlur': { es: 'Desenfoque de movimiento', en: 'Motion blur' },
  'set.motionBlur.hint': {
    es: 'Nunca se aplica al centro del cuadro.',
    en: 'Never applied to the centre of the frame.',
  },
  'set.ssao': { es: 'Oclusión ambiental', en: 'Ambient occlusion' },
  'set.ssao.hint': {
    es: 'Sombra de contacto donde la pared toca la calle.',
    en: 'Contact shadow where the wall meets the street.',
  },

  'set.master': { es: 'Volumen general', en: 'Master volume' },
  'set.master.hint': { es: '', en: '' },
  'set.music': { es: 'Música', en: 'Music' },
  'set.music.hint': {
    es: 'Bomba, plena y salsa desde las ventanas abiertas.',
    en: 'Bomba, plena and salsa out of the open windows.',
  },
  'set.sfx': { es: 'Efectos', en: 'Sound effects' },
  'set.sfx.hint': {
    es: 'Motor, gomas, choques, bocina y pasajeros.',
    en: 'Engine, tyres, crashes, horn and passengers.',
  },

  'set.invertLook': { es: 'Invertir cámara', en: 'Invert look' },
  'set.invertLook.hint': {
    es: 'Invierte el eje vertical de la cámara libre.',
    en: 'Flips the vertical axis of the free camera.',
  },
  'set.minimap': { es: 'Minimapa', en: 'Minimap' },
  'set.minimap.hint': {
    es: 'Que gire contigo, o que el norte quede siempre arriba.',
    en: 'Rotate with the car, or keep north pinned to the top.',
  },
  'opt.rotates': { es: 'Gira', en: 'Rotates' },
  'opt.northUp': { es: 'Norte arriba', en: 'North up' },
  'set.units': { es: 'Unidades de velocidad', en: 'Speed units' },
  'set.units.hint': {
    es: 'En Puerto Rico las distancias van en kilómetros y los límites en millas por hora. Las dos cosas, a la vez, de verdad.',
    en: 'In Puerto Rico distances are in kilometres and speed limits in miles per hour. Both at once, genuinely.',
  },

  'settings.touchLegend': { es: 'CONTROLES EN PANTALLA', en: 'On-screen controls' },
  'set.touchMode': { es: 'Controles táctiles', en: 'Touch controls' },
  'set.touchMode.hint': {
    es: 'AUTO los muestra solo en pantallas táctiles.',
    en: 'AUTO shows them only on a touchscreen.',
  },
  'opt.auto': { es: 'AUTO', en: 'AUTO' },
  'opt.always': { es: 'SIEMPRE', en: 'ALWAYS' },
  'opt.never': { es: 'NUNCA', en: 'NEVER' },
  'set.hand': { es: 'Mano', en: 'Handedness' },
  'set.hand.hint': {
    es: 'Dónde va la dirección: a la izquierda para diestros.',
    en: 'Which side steering sits on: left for right-handers.',
  },
  'opt.rightHand': { es: 'DIESTRO', en: 'RIGHT' },
  'opt.leftHand': { es: 'ZURDO', en: 'LEFT' },
  'set.scheme': { es: 'Dirección táctil', en: 'Touch steering' },
  'set.scheme.hint': {
    es: 'Palanca flotante, volante, o dos flechas grandes.',
    en: 'Floating stick, steering wheel, or two big arrows.',
  },
  'opt.stick': { es: 'PALANCA', en: 'STICK' },
  'opt.wheel': { es: 'VOLANTE', en: 'WHEEL' },
  'opt.zones': { es: 'FLECHAS', en: 'ARROWS' },
  'set.touchScale': { es: 'Tamaño de los botones', en: 'Control size' },
  'set.touchScale.hint': {
    es: 'Se ajusta también al tamaño de la pantalla.',
    en: 'Also adapts to the size of the screen.',
  },
  'set.touchOpacity': { es: 'Opacidad de los controles', en: 'Control opacity' },
  'set.touchOpacity.hint': {
    es: 'Cuánto tapan la ciudad cuando no los estás tocando.',
    en: 'How much of the city they cover when untouched.',
  },
  'set.haptics': { es: 'Vibración', en: 'Haptics' },
  'set.haptics.hint': {
    es: 'Un toque corto al pulsar y al derrapar.',
    en: 'A short buzz on press and through a drift.',
  },
  'set.haptics.unsupported': {
    es: 'Este navegador no puede vibrar (Safari en iPhone nunca lo permite).',
    en: 'This browser cannot vibrate (Safari on iPhone never allows it).',
  },

  'keys.title': { es: 'MANDOS', en: 'Controls' },
  'keys.throttle': { es: 'Acelerar', en: 'Throttle' },
  'keys.brake': { es: 'Frenar / atrás', en: 'Brake / reverse' },
  'keys.steer': { es: 'Girar', en: 'Steer' },
  'keys.handbrake': { es: 'Freno de mano', en: 'Handbrake' },
  'keys.boost': { es: 'Turbo', en: 'Boost' },
  'keys.horn': { es: 'Bocina', en: 'Horn' },
  'keys.camera': { es: 'Cámara', en: 'Camera' },
  'keys.respawn': { es: 'Reaparecer', en: 'Respawn' },
  'keys.pause': { es: 'Pausa', en: 'Pause' },
  'keys.pad': {
    es: 'Mando: gatillos para acelerar y frenar, A confirma, B vuelve.',
    en: 'Gamepad: triggers to drive and brake, A confirms, B goes back.',
  },

  /* ------------------------------------------------------ touch controls */
  'touch.aria.steer': {
    es: 'Zona de dirección — arrastra el pulgar para girar.',
    en: 'Steering area — drag your thumb to steer.',
  },
  'touch.gas': { es: 'GAS', en: 'GAS' },
  'touch.brake': { es: 'FRENO', en: 'BRAKE' },
  'touch.drift': { es: 'DERRAPE', en: 'DRIFT' },
  'touch.boost': { es: 'TURBO', en: 'BOOST' },
  'touch.horn': { es: 'BOCINA', en: 'HORN' },
  'touch.flip': { es: 'ENDEREZAR', en: 'FLIP' },
  'touch.pause': { es: 'Pausa', en: 'Pause' },
  'touch.setup': { es: 'Ajustar controles', en: 'Adjust controls' },
  'touch.panel': { es: 'CONTROLES', en: 'Touch controls' },
  'touch.panel.aria': { es: 'Ajustes de controles táctiles', en: 'Touch control settings' },
  'touch.done': { es: 'LISTO', en: 'Done' },
  'touch.move': { es: 'MOVER', en: 'Reposition' },
  'touch.reset': { es: 'REINICIAR', en: 'Reset' },
  'touch.fullscreen': { es: 'PANTALLA COMPLETA', en: 'Fullscreen' },
  'touch.moveHint': {
    es: 'Con MOVER activo, arrastra cualquier grupo de botones a donde te quede cómodo.',
    en: 'With REPOSITION on, drag any cluster of buttons wherever it suits you.',
  },
  'touch.short.hand': { es: 'MANO', en: 'Hand' },
  'touch.short.steering': { es: 'DIRECCIÓN', en: 'Steering' },
  'touch.short.size': { es: 'TAMAÑO', en: 'Size' },
  'touch.short.opacity': { es: 'OPACIDAD', en: 'Opacity' },
  'touch.short.haptics': { es: 'VIBRACIÓN', en: 'Haptics' },
  'touch.short.handHint': { es: 'Dónde va la dirección.', en: 'Which side steering sits on.' },
  'touch.short.steerHint': {
    es: 'Palanca flotante, volante o flechas.',
    en: 'Floating stick, wheel or arrows.',
  },
  'touch.short.sizeHint': { es: 'Escala de los botones.', en: 'Scale of the buttons.' },
  'touch.short.opacityHint': { es: 'Cuánto tapan la ciudad.', en: 'How much city they cover.' },

  'rotate.aria': { es: 'Gira el teléfono', en: 'Rotate your phone' },
  'rotate.title': { es: 'GIRA EL TELÉFONO', en: 'Turn your phone' },
  'rotate.body': {
    es: 'Se maneja de lado. Ponlo horizontal y dale.',
    en: 'This drives sideways. Go landscape and go.',
  },
  'rotate.anyway': { es: 'JUGAR ASÍ', en: 'Play anyway' },

  /* --------------------------------------------------------- UI messages */
  'msg.quality': { es: 'Calidad', en: 'Quality' },
  'msg.hailing': { es: 'te hace señas', en: 'is flagging you down' },
  'msg.aboard': { es: '¡Pasajero a bordo!', en: 'Passenger aboard!' },
  'msg.bailTimeout': { es: 'se cansó de esperar', en: 'got tired of waiting' },
  'msg.bailScared': { es: 'se bajó del susto', en: 'bailed out, terrified' },
  'msg.thePassenger': { es: 'El pasajero', en: 'The passenger' },
  'msg.seconds': { es: 'SEGUNDOS', en: 'SECONDS' },
  'msg.extraTime': { es: 'Tiempo extra', en: 'Extra time' },
  'msg.nearMiss': { es: '¡CASI!', en: 'CLOSE!' },
  'msg.bigAir': { es: '¡BIG AIR!', en: 'BIG AIR!' },
  'msg.completed': { es: '¡Completado!', en: 'Complete!' },

  'weather.clear': { es: 'Despejado', en: 'Clear' },
  'weather.rain': { es: 'Lluvia', en: 'Rain' },
  'weather.storm': { es: 'Tormenta', en: 'Storm' },
  'weather.sunset': { es: 'Atardecer', en: 'Sunset' },
  'weather.night': { es: 'Noche', en: 'Night' },
} as const;

export type StringKey = keyof typeof STRINGS;

/* ------------------------------------------------------------------ class */

/** Rendering style for a bound single-element string. */
export type TextStyle = 'primary' | 'pair';

/**
 * The live language state, plus the DOM helpers every screen builds with.
 *
 * One shared instance (`i18n`, below) — the game has exactly one UI root, and
 * threading an instance through nine constructors buys nothing.
 */
export class I18n {
  private modeValue: LangMode = 'both';
  private readonly listeners = new Set<() => void>();

  get mode(): LangMode {
    return this.modeValue;
  }

  /** BCP-47 tag of the language shown first. `both` leads in Spanish. */
  get primaryLang(): 'es' | 'en' {
    return this.modeValue === 'en' ? 'en' : 'es';
  }

  /** True when both languages are rendered. */
  get paired(): boolean {
    return this.modeValue === 'both';
  }

  /** Switch language. Re-runs every registered binding; no-op if unchanged. */
  setMode(mode: LangMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[i18n] binding threw:', err);
      }
    }
  }

  /* -------------------------------------------------------------- lookup */

  es(key: StringKey): string {
    return STRINGS[key].es;
  }

  en(key: StringKey): string {
    return STRINGS[key].en;
  }

  /** The string shown first: Spanish in `both`/`es`, English in `en`. */
  t(key: StringKey): string {
    return this.modeValue === 'en' ? STRINGS[key].en : STRINGS[key].es;
  }

  /** The second string, or `''` when only one language is on screen. */
  alt(key: StringKey): string {
    return this.modeValue === 'both' ? STRINGS[key].en : '';
  }

  /** One-line form: `Volver · Back`, or just one of them. */
  pair(key: StringKey, sep = ' · '): string {
    const p = STRINGS[key];
    if (this.modeValue === 'es') return p.es;
    if (this.modeValue === 'en') return p.en;
    return p.es === p.en ? p.es : `${p.es}${sep}${p.en}`;
  }

  /* ---------------------------------------------------------------- DOM */

  /**
   * Append a static bilingual label to `parent`.
   *
   * Both languages always land in the DOM, each tagged with a real `lang`
   * attribute; the stylesheet hides the unwanted one from `[data-lang]` on the
   * root. That makes a language switch one attribute write with no re-render,
   * and leaves the markup correct for assistive tech in every mode.
   */
  bi(
    parent: Element,
    key: StringKey,
    esClass = 'll-lbl-es',
    enClass = 'll-lbl-en',
    tag: 'span' | 'div' | 'p' = 'span',
  ): void {
    const p = STRINGS[key];
    const a = document.createElement(tag);
    a.className = esClass;
    a.lang = 'es';
    a.textContent = p.es;
    const b = document.createElement(tag);
    b.className = enClass;
    b.lang = 'en';
    b.textContent = p.en;
    parent.append(a, b);
  }

  /**
   * A two-line explanation block — Spanish, then English underneath. Same
   * CSS-driven hiding as `bi`.
   */
  hint(key: StringKey, className = 'll-row__hint'): HTMLElement | null {
    const p = STRINGS[key];
    if (!p.es && !p.en) return null;
    const wrap = document.createElement('div');
    wrap.className = `${className}-wrap`;
    const a = document.createElement('div');
    a.className = className;
    a.lang = 'es';
    a.textContent = p.es;
    const b = document.createElement('div');
    b.className = `${className} ${className}--alt`;
    b.lang = 'en';
    b.textContent = p.en;
    wrap.append(a, b);
    return wrap;
  }

  /**
   * Bind an element's text to a key. Re-renders on a language change, so this
   * is the mechanism for anything that cannot be two static nodes.
   */
  text(node: HTMLElement, key: StringKey, style: TextStyle = 'primary'): () => void {
    const render = (): void => {
      const next = style === 'pair' ? this.pair(key) : this.t(key);
      if (node.textContent !== next) node.textContent = next;
      node.lang = this.primaryLang;
    };
    render();
    return this.onChange(render);
  }

  /** Bind an attribute (`aria-label`, `title`) to a key. */
  attr(node: Element, name: string, key: StringKey): () => void {
    const render = (): void => node.setAttribute(name, this.t(key));
    render();
    return this.onChange(render);
  }

  /**
   * Register an arbitrary render callback for composed strings — counted nouns,
   * interpolated values, anything the two helpers above cannot express.
   * Runs immediately, then on every mode change.
   */
  bind(render: () => void): () => void {
    render();
    return this.onChange(render);
  }

  /** Subscribe without an immediate call. Returns an unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

/** The shared instance. `UITheme.apply` keeps it in step with settings. */
export const i18n = new I18n();
