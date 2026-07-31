/**
 * Loco Lift — the regulars.
 *
 * `Dialogue.ts` holds who a passenger *is*. This file holds what happens to
 * them. Every archetype has a through-line that advances as the player keeps
 * picking them up: the bomba drummer chases a break and ends up teaching kids,
 * the pastelería owner grows out of one oven, the cruise guest who keeps
 * missing the fort finally sees it, the abuela who hates your driving turns out
 * to have ridden with your uncle for thirty years.
 *
 * Mechanics, deliberately small:
 *
 *  - A stage opens at a cumulative ride count with that specific person.
 *    `ARC_THRESHOLDS` is the ladder; nothing else gates it, so the arcs advance
 *    in any mode, in any order, at whatever pace the player actually plays.
 *  - A stage is a *replacement* line bank layered over the base one. The
 *    director prefers arc lines and falls through to the base bank for any
 *    trigger the stage does not cover, so no trigger can ever go silent.
 *  - Reaching a stage fires one toast (`note`) — the only time the game tells
 *    you a relationship moved. Everything else is learned from the back seat.
 *
 * Cultural rules from ART_REFERENCE §7 are binding here exactly as they are in
 * `Dialogue.ts`: correct accented Spanish, real code-switching, and the joke is
 * always the situation, never the person.
 */
import type { DialogueLine, DialogueTrigger, PassengerMood } from '../core/types';

/* ------------------------------------------------------------------ types */

const L = (
  trigger: DialogueTrigger,
  text: string,
  cooldown = 40,
  mood?: PassengerMood,
): DialogueLine => ({ trigger, text, cooldown, mood });

export interface ArcStage {
  /** stable id, `<archetype>-<n>`; used for the "seen this beat" ledger */
  id: string;
  /** short title for the codex / results screen */
  title: string;
  /** one line the toast uses the moment the stage opens */
  note: string;
  /** lines layered over the archetype's base bank while this stage is live */
  lines: readonly DialogueLine[];
}

export interface PassengerArc {
  archetypeId: string;
  /** the character's whole through-line in one sentence */
  premise: string;
  /** stage 1..n; stage 0 is the base bank in `Dialogue.ts` */
  stages: readonly ArcStage[];
}

/**
 * Rides with one person needed to reach stage 1, 2, 3. Deliberately short:
 * a player who likes somebody should see them change inside an evening, and
 * the whole cast is 18 people, so nobody is grinding one archetype.
 */
export const ARC_THRESHOLDS: readonly number[] = [3, 7, 12];

/* ------------------------------------------------------------- the arcs */

const KIQUE: PassengerArc = {
  archetypeId: 'bomba-drummer',
  premise: 'Un barril heredado y un toque fijo que todavía no existe.',
  stages: [
    {
      id: 'bomba-drummer-1',
      title: 'El toque de los viernes',
      note: 'Kique consiguió el toque de los viernes en el Salón. Fijo.',
      lines: [
        L('pickup', 'Ya no es un bombazo cualquiera. Los viernes son míos ahora. Míos.'),
        L('pickup', 'Al salón otra vez. Y esta vez me esperan, que es distinto.'),
        L('idle', 'Me dieron los viernes. Fijo. Con mi nombre en la pizarra y todo.'),
        L('idle', 'Lo primero que hice fue llamar a mi mamá. Lo segundo, afinar el cuero.'),
        L('idle', 'Tú fuiste el que me llevó el primer día. Eso no se me olvida, mano.'),
        L('drift', '¡Ese repique va en el set de los viernes!', 16),
        L('dropoff', 'Nos vemos el viernes. Tú no pagas entrada, eso está hablado.'),
        L('perfect', 'Llegué caliente y a tiempo. Así se empieza un toque.'),
      ],
    },
    {
      id: 'bomba-drummer-2',
      title: 'El disco',
      note: 'Van a grabar al grupo de Kique. El cuero del barril lo tiene nervioso.',
      lines: [
        L('pickup', 'Hoy graban. El cuero está seco y yo estoy peor.'),
        L('pickup', 'Nos van a grabar. A nosotros. Con micrófonos de verdad.'),
        L('idle', 'El barril era de mi abuelo. Si suena en un disco, suena él.'),
        L('idle', 'Dicen que el cuero se oye distinto con humedad. Hoy hay humedad.'),
        L('idle', 'Tengo un solo de ocho compases. Ocho. Llevo dos semanas con ellos.'),
        L('crash', '¡El barril, mano! Hoy no. Hoy no, por favor.', 12),
        L('dropoff', 'Deséame algo. Lo que sea. Ya lo cogí.'),
        L('perfect', 'Llegué entero y el cuero también. Eso ya es medio disco.'),
      ],
    },
    {
      id: 'bomba-drummer-3',
      title: 'La escuela',
      note: 'Kique da clase de barril los sábados en El Perlo. Van once nenes.',
      lines: [
        L('pickup', 'Los sábados doy clase en El Perlo. Once nenes, once barriles prestados.'),
        L('idle', 'Hay una nena de nueve años que toca mejor que yo a los veinte. Da coraje y orgullo.'),
        L('idle', 'Les enseño lo mismo que me enseñaron: el golpe no es fuerza, es sitio.'),
        L('idle', 'Uno me preguntó si esto da dinero. Le dije la verdad y vino igual.'),
        L('idle', 'Mi abuelo enseñaba gratis. Yo también. Es lo mismo, con más ruido.'),
        L('dropoff', 'Gracias. Si un sábado te sobra una hora, pásate. Te pongo a llevar el tiempo.'),
        L('perfect', 'Tú llegas en clave. Eso es lo primero que les enseño a ellos.'),
      ],
    },
  ],
};

const YOLANDA: PassengerArc = {
  archetypeId: 'bakery-owner',
  premise: 'Cuarenta años de un solo horno, y de repente hay que decidir si son dos.',
  stages: [
    {
      id: 'bakery-owner-1',
      title: 'El segundo horno',
      note: 'Doña Yolanda compró un segundo horno. Todavía no sabe dónde ponerlo.',
      lines: [
        L('pickup', 'Compré un horno. Está en la sala de mi casa. No me pregunte.'),
        L('pickup', 'Vamos, mi amor, que hoy horneo el doble y duermo la mitad.'),
        L('idle', 'Dos hornos. Cuarenta años con uno y ahora dos. Mi mamá se estaría riendo.'),
        L('idle', 'El de arriba calienta desigual. Hay que virar la bandeja a los doce minutos.'),
        L('idle', 'La gente hace fila desde las seis. ¿Usted sabe lo que es eso a mi edad?'),
        L('drift', '¡Ay, joven! Con dos hornos tengo el doble que perder.', 12),
        L('dropoff', 'Llegó entero. Pase el lunes, que estreno el horno con quesitos.'),
        L('perfect', 'Ni una grieta. Usted es de fiar, y eso se lo digo a poca gente.'),
      ],
    },
    {
      id: 'bakery-owner-2',
      title: 'La aprendiz',
      note: 'Doña Yolanda cogió una aprendiz. Bate el buttercream como si le debiera dinero.',
      lines: [
        L('pickup', 'Cogí una aprendiz. Diecinueve años, dos manos buenas y una prisa terrible.'),
        L('idle', 'Le dije: el bizcocho se sabe cuándo está. No hay reloj para eso. Me miró raro.'),
        L('idle', 'Bate el buttercream como si le debiera dinero. Yo era igualita.'),
        L('idle', 'Ayer sacó una bandeja perfecta y no me lo dijo. Se lo tuve que sacar yo.'),
        L('idle', 'Si sigue así, en dos años yo me siento y ella hornea. Dos años, ni uno menos.'),
        L('dropoff', 'Gracias. Y dígale a ella que quedó bien, que a mí me da cosa decírselo.'),
        L('perfect', 'Manos buenas. Como las de ella. Como las mías cuando servían.'),
      ],
    },
    {
      id: 'bakery-owner-3',
      title: 'El mostrador del mercado',
      note: 'Doña Yolanda abre mostrador en el Mercado de la Marina. Su hija vuelve a llevarlo.',
      lines: [
        L('pickup', 'Al mercado. Tengo mostrador propio allá desde el jueves. Mostrador propio.'),
        L('idle', 'Mi hija se vuelve a llevarlo. Doce años afuera. Doce.'),
        L('idle', 'Dice que aprendió contabilidad. Le dije que aquí se cuenta con las manos. Bueno.'),
        L('idle', 'El domingo no abro. Primer domingo cerrado en cuarenta y un años.'),
        L('idle', 'No sé qué se hace un domingo sin horno. Voy a averiguar.'),
        L('dropoff', 'Tenga. Y el domingo, si me ve sentada en la plaza sin hacer nada, no me salude.'),
        L('perfect', 'Usted empezó conmigo cuando yo tenía un horno. Míreme ahora.'),
      ],
    },
  ],
};

const MARLA: PassengerArc = {
  archetypeId: 'cruise-guest',
  premise: 'Four visits, seventeen magnets, and she still has not seen the fort.',
  stages: [
    {
      id: 'cruise-guest-1',
      title: 'Second time around',
      note: 'Marla came back. Different ship. Still has not seen the fort.',
      lines: [
        L('pickup', 'Me again! Different ship, same nine minutes. It\'s a pattern, I know.'),
        L('pickup', '¡Hola! Sí, es la misma. La del crucero. See? I practiced.'),
        L('idle', 'I came back. My husband thinks I\'m insane. He is not entirely wrong.'),
        L('idle', 'Four hours in port. Four! I spent one of them buying coffee for my sister.'),
        L('idle', 'I still haven\'t seen the fort. Everyone asks. I lie.'),
        L('idle', 'The magnets are on my fridge in rows now. My daughter calls it "the wall".'),
        L('dropoff', 'Made it. Again. ¡Gracias! — I\'m saying it right this time, aren\'t I?'),
        L('perfect', 'You are the only person on this island who has never made me late.'),
      ],
    },
    {
      id: 'cruise-guest-2',
      title: 'La semana entera',
      note: 'Marla booked a whole week. No ship. A week.',
      lines: [
        L('pickup', 'No ship this time. A whole week. I have a rental with a balcony and everything.'),
        L('idle', 'Seven days. I keep checking the time like something\'s about to leave without me.'),
        L('idle', 'The lady at the panadería remembered my order. I nearly cried in the street.'),
        L('idle', 'I learned "ay bendito". I use it constantly. Possibly wrongly.'),
        L('idle', 'Still haven\'t made it up to the fort. I know. I KNOW.'),
        L('drift', 'Okay — that one I actually enjoyed. Don\'t tell my husband.', 14),
        L('dropoff', 'Same time tomorrow? I\'m serious. I\'ll be right here.'),
        L('perfect', 'A whole week, and this is still the best part of my day.'),
      ],
    },
    {
      id: 'cruise-guest-3',
      title: 'El fuerte, por fin',
      note: 'Marla finally saw the fort. From the wall. She went quiet for a full minute.',
      lines: [
        L('pickup', 'Take me up to the wall. I don\'t care how long it takes. I have time now.'),
        L('idle', 'I saw it. Four visits and I finally saw it.'),
        L('idle', 'I stood by one of the little sentry boxes for twenty minutes doing nothing at all.'),
        L('idle', 'Nobody rushed me. That was the whole trick. Nobody rushed me.'),
        L('idle', 'My daughter comes in March. I\'m taking her straight up there. First thing.'),
        L('almostThere', 'Slow down a second. I want to look at it properly this time.', 22),
        L('dropoff', 'Thank you. And I mean for all of it, not just today.'),
        L('perfect', 'Keep the change. Buy something for this Jeep — it has earned it.'),
      ],
    },
  ],
};

const CARMEN: PassengerArc = {
  archetypeId: 'abuela',
  premise: 'Setenta y ocho años calificando choferes. Contigo va a hacer una excepción, despacito.',
  stages: [
    {
      id: 'abuela-1',
      title: 'Preguntó por tu mamá',
      note: 'Doña Carmen preguntó por tu mamá. Eso, viniendo de ella, es un ascenso.',
      lines: [
        L('pickup', 'Otra vez tú. Bueno. Por lo menos ya sé qué esperar.'),
        L('idle', '¿Y tu mamá? ¿Está bien? Dile que preguntó Carmen, la de la calle del medio.'),
        L('idle', 'Yo no me monto con cualquiera, que conste. Contigo me monto porque me queda de paso.'),
        L('idle', 'Frenaste bien en esa esquina. No te emociones, fue una.'),
        L('drift', '¡Nene! Ya te conozco y aun así me asustas.', 12),
        L('dropoff', 'Toma. Y cómprate un café, no un refresco. Un café.'),
        L('perfect', 'Bueno. Manejaste como gente. Que conste que lo dije yo primero.'),
      ],
    },
    {
      id: 'abuela-2',
      title: 'El envase',
      note: 'Doña Carmen te trajo comida. No lo menciones, la avergüenza.',
      lines: [
        L('pickup', 'Toma, antes de arrancar. Arroz con habichuelas. No preguntes, cómetelo.'),
        L('idle', 'Estás flaco todavía. Uno no maneja bien con hambre, eso lo sabe cualquiera.'),
        L('idle', 'Mi hijo el del medio manejaba igualito que tú. Ya no maneja, se mudó.'),
        L('idle', 'Me gusta ir contigo porque tú me contestas. Los otros ponen música y ya.'),
        L('idle', 'No te acostumbres a la comida. Fue una vez. Bueno, dos.'),
        L('crash', '¿Tú ves? Y yo que te traje comida.', 12),
        L('dropoff', 'Devuélveme el envase el jueves. Y lavado.'),
        L('perfect', 'Así. Exactamente así. ¿Ves que sí sabes?'),
      ],
    },
    {
      id: 'abuela-3',
      title: 'Los jueves de Wiso',
      note: 'Doña Carmen montaba con tu tío Wiso. Treinta años, todos los jueves.',
      lines: [
        L('pickup', 'Siéntate derecho. Tu tío se sentaba torcido y se lo dije treinta años.'),
        L('idle', 'Yo montaba con Wiso los jueves. Treinta años. Nunca me cobró completo, el sinvergüenza.'),
        L('idle', 'Él tampoco frenaba bien al principio. Se le arregló como a los cinco años.'),
        L('idle', 'Cuando lo operaron lloré en la cocina. No se lo digas.'),
        L('idle', 'Tú tienes su manera de mirar el espejo. Igualita. Da cosa.'),
        L('idle', 'Ya no te voy a decir cómo manejar. Bueno. Casi.'),
        L('dropoff', 'Toma. Y no me des las gracias, que me pone incómoda.'),
        L('perfect', 'Manejas bien, nene. Ya está, lo dije. No me lo hagas repetir.'),
      ],
    },
  ],
};

const YANIEL: PassengerArc = {
  archetypeId: 'muralist',
  premise: 'Una pared grande, una beca que no llega, y la ciudad mirando pa\' otro lado.',
  stages: [
    {
      id: 'muralist-1',
      title: 'La pared grande',
      note: 'A Yaniel le dieron la pared grande del callejón. Entera.',
      lines: [
        L('pickup', 'Me dieron la pared. La grande. La del callejón entero.'),
        L('idle', 'Ocho metros de alto. Ocho. Voy a necesitar andamio y valor.'),
        L('idle', 'Lo que va ahí lo llevo pensando desde los quince años.'),
        L('idle', 'La señora del segundo piso me dio permiso y café. En ese orden.'),
        L('dropoff', 'Cuando la termine te aviso. Vas a estar ahí, en una esquina. Chiquito, pero ahí.'),
        L('perfect', 'Rápido y sin sacudirme las latas. Eso es un arte aparte.'),
      ],
    },
    {
      id: 'muralist-2',
      title: 'Se cayó la beca',
      note: 'Se cayó la beca de Yaniel. Sigue pintando igual.',
      lines: [
        L('pickup', 'Se cayó la beca. Dale igual, arranca.'),
        L('idle', 'Me dijeron que "no cualificaba". Cuatro meses para decirme eso.'),
        L('idle', 'La pintura la estoy pagando yo. Vendí la bicicleta. No me mires así.'),
        L('idle', 'La pared no sabe de becas. La pared sigue ahí, en blanco, esperando.'),
        L('crash', 'Ey, las latas. Ahora sí que no hay para más.', 12),
        L('dropoff', 'Gracias, pana. Y tranquilo, que esto se termina igual.'),
        L('perfect', 'Bien ahí. Hoy necesitaba que algo saliera bien.'),
      ],
    },
    {
      id: 'muralist-3',
      title: 'La pared terminada',
      note: 'Yaniel terminó la pared. Viene gente de otros barrios a verla.',
      lines: [
        L('pickup', 'La terminé. Anoche a las tres. Ve a verla cuando puedas.'),
        L('idle', 'Viene gente de Piñones a verla. De Piñones, mano.'),
        L('idle', 'Puse a mi mamá en la esquina de abajo. Se dio cuenta sola y se sentó a llorar.'),
        L('idle', 'Un nene me preguntó cómo se aprende. Le di una lata y una pared chiquita.'),
        L('idle', 'Ahora me llaman de tres sitios. Voy a decir que sí a uno y que no a dos.'),
        L('dropoff', 'Búscate en la esquina de arriba a la derecha. Vas manejando. Se te ve el codo.'),
        L('perfect', 'Tú y yo llegamos rápido a sitios distintos, pero llegamos.'),
      ],
    },
  ],
};

const TATO: PassengerArc = {
  archetypeId: 'surfer',
  premise: 'Un swell que siempre entra cuando él está trabajando.',
  stages: [
    {
      id: 'surfer-1',
      title: 'Se acabó el trabajo',
      note: 'A Tato lo botaron del trabajo. Está sospechosamente contento.',
      lines: [
        L('pickup', 'Bro, me botaron. Arranca antes de que me arrepienta de estar feliz.'),
        L('idle', 'Tercera vez al dentista en dos semanas. No coló.'),
        L('idle', 'Tengo tres meses de ahorros y seis meses de olas. Los números no me cuadran.'),
        L('idle', 'Mi mamá lo cogió mejor que yo. Me dijo "ya era hora". Me dio miedo.'),
        L('dropoff', 'Gracias, pana. Hoy sí llego con la marea.'),
        L('perfect', 'Sin trabajo y con esta llegada. El día va bien.'),
      ],
    },
    {
      id: 'surfer-2',
      title: 'Dando clases',
      note: 'Tato está dando clases de tabla. Cobra poco y enseña bien.',
      lines: [
        L('pickup', 'Tengo dos clases hoy. Sí, clases. Yo. Enseñando.'),
        L('idle', 'Le cobro veinte a los de afuera y nada a los del barrio. Así funciona.'),
        L('idle', 'Hoy paré a una nena de siete años en la primera ola. De la primera, bro.'),
        L('idle', 'Lo difícil no es la tabla. Es que no le cojan miedo al agua.'),
        L('idle', 'Mi mamá decía que eso no es trabajo. Cobré ochenta pesos ayer y se calló.'),
        L('dropoff', 'Brutal. Si un día quieres, te enseño. En serio, sin cobrarte.'),
        L('perfect', 'Tú manejas como se coge una ola limpia: sin apretar.'),
      ],
    },
    {
      id: 'surfer-3',
      title: 'La escuelita',
      note: 'Tato montó escuelita en la playa. Ocho tablas y un toldo.',
      lines: [
        L('pickup', 'Ocho tablas, un toldo y una libreta. Eso es la escuela, bro. Ya está.'),
        L('idle', 'Le puse el nombre de mi abuelo. Él nunca se metió al agua, pero bueno.'),
        L('idle', 'Los sábados vienen los nenes de El Perlo. Kique me los manda después del barril.'),
        L('idle', 'Ya no persigo el swell. Ahora el swell me encuentra trabajando.'),
        L('idle', 'Tengo lista de espera. Yo. Lista de espera.'),
        L('dropoff', 'Pásate el sábado. Hay agua de coco y ruido de nenes. Es lo mejor que tengo.'),
        L('perfect', 'Bro, tú llevas años llegándome a tiempo. Esto empezó contigo, que conste.'),
      ],
    },
  ],
};

const IRIS: PassengerArc = {
  archetypeId: 'tour-guide',
  premise: 'Veinte años contando la misma ciudad y todavía encuentra cosas que no sabía.',
  stages: [
    {
      id: 'tour-guide-1',
      title: 'El libro',
      note: 'La Profesora Iris está escribiendo un libro. Va por el capítulo dos.',
      lines: [
        L('pickup', 'Al mirador. Y si le hago preguntas raras, es por el libro.'),
        L('idle', 'Estoy escribiendo. Un libro, sí. De la ciudad. Alguien tenía que hacerlo bien.'),
        L('idle', '¿Sabe cuántas casas del casco conservan aljibe? Yo tampoco. Lo estoy contando.'),
        L('idle', 'Voy por el capítulo dos. Llevo siete meses en el capítulo dos.'),
        L('dropoff', 'Gracias. Esa esquina por la que dobló me acaba de resolver un párrafo.'),
        L('perfect', 'Puntual e ileso. Le voy a poner en los agradecimientos, no se ría.'),
      ],
    },
    {
      id: 'tour-guide-2',
      title: 'Muy local',
      note: 'Dos editoriales le rechazaron el libro a Iris. Sigue escribiendo.',
      lines: [
        L('pickup', 'Dos editoriales. Dos. "Muy local", dijeron. Arranque, por favor.'),
        L('idle', '"Muy local." Es un libro sobre una ciudad. ¿Qué esperaban, Marte?'),
        L('idle', 'Mi grupo de las seis lo sabe y no me lo menciona. Son buena gente.'),
        L('idle', 'Le leí un capítulo a un guardia del muelle y lloró. Eso vale más que una editorial.'),
        L('idle', 'Voy a seguir. Con lo que cobro caminando, pero voy a seguir.'),
        L('dropoff', 'Gracias. Hoy usted fue lo único que llegó a tiempo.'),
        L('perfect', 'Impecable. Necesitaba ver algo hecho bien hoy.'),
      ],
    },
    {
      id: 'tour-guide-3',
      title: 'Quinientos ejemplares',
      note: 'Iris publicó el libro ella misma. Se vendió entero en tres semanas.',
      lines: [
        L('pickup', 'Lo imprimí yo. Quinientos ejemplares. Quedan doce.'),
        L('idle', 'Tres semanas. La segunda edición sale en abril.'),
        L('idle', 'Una señora de noventa años me trajo una foto de su casa de 1946 para el segundo tomo.'),
        L('idle', 'Ahora me llaman de la universidad. Después de veinte años caminando, ahora.'),
        L('idle', 'Le guardé uno. En serio, tengo uno con su nombre. Recuérdemelo.'),
        L('almostThere', 'Pare aquí un segundo. Quiero enseñarle algo que ya no está en el libro.', 22),
        L('dropoff', 'Tenga. Página ciento cuatro. Sale un chofer sin nombre. Es usted.'),
        L('perfect', 'Rápido, limpio y por la ruta bonita. Eso es un capítulo entero.'),
      ],
    },
  ],
};

const BRYAN: PassengerArc = {
  archetypeId: 'first-timer',
  premise: 'Primera semana, primer trabajo, primer sitio donde nadie le explica nada.',
  stages: [
    {
      id: 'first-timer-1',
      title: 'Empezó el trabajo',
      note: 'Bryan empezó el trabajo. Le dijeron a las ocho y llegó a las siete.',
      lines: [
        L('pickup', 'Empecé el lunes. Llegué una hora antes. No había nadie. Nadie.'),
        L('idle', 'Aprendí que "ahorita" no quiere decir ahorita. Me tomó tres días.'),
        L('idle', 'Mi jefe me dijo "dale" y yo dije "¿dale qué?". Se rió diez minutos.'),
        L('idle', 'Ya no me pierdo tanto. Bueno, me pierdo, pero a propósito.'),
        L('dropoff', 'Gracias. Ya me sé esta esquina. Yo solo, sin teléfono.'),
        L('perfect', 'Eso estuvo chévere. Lo dije bien esta vez, ¿verdad? Sí. Sí lo dije bien.'),
      ],
    },
    {
      id: 'first-timer-2',
      title: 'Sobrevivió el chinchorreo',
      note: 'A Bryan lo invitaron a un chinchorreo y volvió a las cuatro. Vivo.',
      lines: [
        L('pickup', 'Fui a un chinchorreo. Volví a las cuatro. Estoy vivo, técnicamente.'),
        L('idle', 'Me llevaron a Piñones. Comí algo frito que no supe nombrar y fue lo mejor del mes.'),
        L('idle', 'Ahora tengo grupo de chat. Cuarenta mensajes al día. Entiendo el sesenta por ciento.'),
        L('idle', 'Mi mamá preguntó si estoy comiendo bien. Le mandé una foto y se quedó tranquila.'),
        L('idle', 'Alguien me dijo "papi" y ya no me da cosa. Progreso.'),
        L('dropoff', 'Nos vemos, pana. ¿Ves? Pana. Lo estoy usando.'),
        L('perfect', 'Eso fue brutal. Y sé lo que significa, lo aprendí bien.'),
      ],
    },
    {
      id: 'first-timer-3',
      title: 'El del tercer piso',
      note: 'Bryan alquiló en el casco. Ahora él le explica la ciudad a otro recién llegado.',
      lines: [
        L('pickup', 'Me mudé al casco. Tercer piso, sin ascensor, con balcón. Valió la pena.'),
        L('idle', 'Llegó uno nuevo a la oficina. Ayer le expliqué lo de "ahorita". Me sentí viejo y feliz.'),
        L('idle', 'Ya sé cuál panadería abre a las cinco y cuál miente.'),
        L('idle', 'El domingo me senté en la plaza sin plan. Dos horas sin hacer nada. Perfecto.'),
        L('idle', 'Mi mamá viene en diciembre. Le voy a enseñar todo esto. Todo.'),
        L('dropoff', 'Gracias. Tú fuiste el primero que me habló normal aquí. Eso lo tengo guardado.'),
        L('perfect', 'Hace un año yo cerraba los ojos en las curvas. Míranos ahora.'),
      ],
    },
  ],
};

const MILLIE: PassengerArc = {
  archetypeId: 'salsa-dancer',
  premise: 'Una rodilla que avisa y una academia que todavía no existe.',
  stages: [
    {
      id: 'salsa-dancer-1',
      title: 'Primera línea',
      note: 'A Millie la subieron a primera línea. El compañero nuevo todavía la pisa.',
      lines: [
        L('pickup', 'Me subieron a primera línea. Al frente, con luz encima y todo.'),
        L('idle', 'Primera línea quiere decir que si me equivoco lo ve la sala entera.'),
        L('idle', 'El compañero nuevo mejoró. Ya solo me pisa los martes.'),
        L('idle', 'Llevo dos semanas soñando la coreografía. Dormida. Del uno al ocho.'),
        L('dropoff', 'Ay, gracias. Llegué caliente. Eso es medio ensayo ganado.'),
        L('perfect', 'Del uno al ocho sin perder el tiempo. Tú sirves para esto.'),
      ],
    },
    {
      id: 'salsa-dancer-2',
      title: 'La rodilla',
      note: 'A Millie se le dañó la rodilla. Está bailando con venda y con coraje.',
      lines: [
        L('pickup', 'Voy con venda. No me digas nada. Arranca.'),
        L('idle', 'La rodilla derecha. Me avisó tres veces y yo seguí. Culpa mía.'),
        L('idle', 'El médico dijo tres meses. Yo dije tres semanas. Vamos a ver quién gana.'),
        L('idle', 'Enseñar sí puedo. Marcar el paso sentada. No es lo mismo, pero es algo.'),
        L('idle', 'Nunca había estado quieta tanto tiempo. No sé qué hacer con las manos.'),
        L('drift', '¡Ay! Sin brincos hoy, mi amor, que voy coja.', 12),
        L('dropoff', 'Gracias por ir suave. Lo noté. En serio.'),
        L('perfect', 'Suave y a tiempo. Hoy eso vale doble.'),
      ],
    },
    {
      id: 'salsa-dancer-3',
      title: 'La academia',
      note: 'Millie abrió academia. De martes a sábado, y la primera clase es gratis.',
      lines: [
        L('pickup', 'A la academia. Mi academia. Todavía se me hace raro decirlo.'),
        L('idle', 'Alquilé un salón con espejos y piso de madera. Me endeudé hasta las cejas y estoy feliz.'),
        L('idle', 'La primera clase es gratis. Siempre. A mí la primera me la regalaron.'),
        L('idle', 'La rodilla aguanta si no hago tonterías. Hago pocas tonterías ahora. Pocas.'),
        L('idle', 'Tengo una alumna de sesenta y dos años. Empezó en enero y no falta ni un martes.'),
        L('dropoff', 'Los martes a las siete. Ya te lo dije veinte veces. Un día vas a venir.'),
        L('perfect', 'Tú llevas el tiempo mejor que media sala, y eso que no bailas.'),
      ],
    },
  ],
};

const KBO: PassengerArc = {
  archetypeId: 'trap-artist',
  premise: 'Un tema que pegó y la duda de si vale la pena irse.',
  stages: [
    {
      id: 'trap-artist-1',
      title: 'Está sonando',
      note: 'El tema de K-Bo está sonando. En las guaguas, en los carros, en todos lados.',
      lines: [
        L('pickup', 'Está sonando, mano. En las guaguas. Ayer lo oí en un carro parado en la luz.'),
        L('idle', 'Nota de voz: "sonó en la calle antes que en la radio". Eso va en el próximo.'),
        L('idle', 'Mi abuela lo puso en su teléfono. A todo volumen. En misa no, pero casi.'),
        L('idle', 'Ochenta mil reproducciones. Yo pensaba que ochocientas ya era mucho.'),
        L('dropoff', 'Brutal. Cuando lo oigas por ahí, acuérdate que te lo dije primero.'),
        L('perfect', 'Tú tienes flow manejando y yo tengo oído. Los dos sabemos.'),
      ],
    },
    {
      id: 'trap-artist-2',
      title: 'La oferta',
      note: 'A K-Bo le ofrecieron mudarse. Lleva tres semanas sin contestar el correo.',
      lines: [
        L('pickup', 'Me ofrecieron irme. Estudio, contrato, todo. Arranca, que necesito pensar.'),
        L('idle', 'Dicen que allá está la industria. Aquí está la música. No es lo mismo.'),
        L('idle', 'Mi mamá me dijo "vete". Mi abuela no dijo nada, y eso fue peor.'),
        L('idle', 'Todo lo que yo hago sale de este bloque. Si me lo llevo, ¿qué me llevo?'),
        L('idle', 'Tres semanas sin contestar el correo. Eso también es una respuesta.'),
        L('dropoff', 'Gracias, mano. Manejar contigo es lo único que me despeja.'),
        L('perfect', 'Limpio. Hoy necesitaba que algo estuviera claro.'),
      ],
    },
    {
      id: 'trap-artist-3',
      title: 'El estudio de arriba',
      note: 'K-Bo se quedó. Montó estudio en el casco y les graba gratis a los nenes.',
      lines: [
        L('pickup', 'Me quedé. Monté el estudio aquí, en el segundo piso de mi tía.'),
        L('idle', 'Les grabo gratis a los nenes del barrio. Los martes. Traen letras en libreta de escuela.'),
        L('idle', 'Hay uno de dieciséis que escribe mejor que yo. Se lo dije y se puso a llorar.'),
        L('idle', 'Los de afuera todavía llaman. Ahora contesto yo y pongo condiciones.'),
        L('idle', 'Metí el ruido de tu carro en un tema. El derrape aquel. Sale en el segundo minuto.'),
        L('dropoff', 'Sube al estudio cuando quieras. La puerta está abierta y el café es malo.'),
        L('perfect', 'Tú y yo empezamos con nada, pana. Mira dónde estamos parqueados.'),
      ],
    },
  ],
};

const NINO: PassengerArc = {
  archetypeId: 'fisherman',
  premise: 'Cuarenta y un años de la misma lancha y un motor que ya no perdona.',
  stages: [
    {
      id: 'fisherman-1',
      title: 'Se partió el motor',
      note: 'Se le partió el motor a Don Nino. Está saliendo con la lancha de su compadre.',
      lines: [
        L('pickup', 'Voy con la lancha de mi compadre. El mío se partió el martes.'),
        L('idle', 'Cuarenta y un años con ese motor. Se murió de viejo, como se muere todo aquí.'),
        L('idle', 'El de mi compadre es más rápido y menos mío. Uno se acostumbra a lo suyo.'),
        L('idle', 'Un motor nuevo son tres mil. Tres mil son muchos chillos.'),
        L('dropoff', 'Llegué. Gracias, mijo. Pasa el jueves que igual te guardo algo.'),
        L('perfect', 'Manejas como quien respeta la carga. Tu tío era igual.'),
      ],
    },
    {
      id: 'fisherman-2',
      title: 'La nieta',
      note: 'Don Nino está enseñando a su nieta. No vomitó el primer día.',
      lines: [
        L('pickup', 'Hoy va mi nieta conmigo. Trece años. No vomitó el primer día, imagínate.'),
        L('idle', 'Yo vomité a los siete. Ella nada. Sacó lo de la abuela, no lo mío.'),
        L('idle', 'Le enseñé a leer el agua. Lo cogió en dos semanas. A mí me tomó dos años.'),
        L('idle', 'Su mamá no quiere. Dice que eso no da. Y tiene razón, pero igual.'),
        L('idle', 'Le regalé mi cuchillo. El bueno. Ella todavía no sabe lo que es eso.'),
        L('dropoff', 'Toma. Si la ves por el muelle, salúdala, que le gusta que la traten de grande.'),
        L('perfect', 'Suave y a tiempo. Eso lo aprecia un viejo con la nevera abierta.'),
      ],
    },
    {
      id: 'fisherman-3',
      title: 'La Terca',
      note: 'Don Nino tiene motor nuevo. Lo pagaron entre seis pescadores del muelle.',
      lines: [
        L('pickup', 'Motor nuevo. Lo pagamos entre seis. Seis. Nadie me lo pidió firmado.'),
        L('idle', 'Eso es el muelle, mijo. Nadie tiene, pero entre todos sí.'),
        L('idle', 'El primer día que lo prendí me temblaban las manos. Cuarenta y un años y me temblaban.'),
        L('idle', 'Mi nieta le puso nombre: "La Terca". Yo quería otro. Ganó ella.'),
        L('idle', 'Ahora salgo más lejos. Hay sitios que no veía desde los treinta años.'),
        L('dropoff', 'Gracias. Y el jueves no me falles, que hay chillo con tu nombre.'),
        L('perfect', 'Tú llegas siempre a tiempo. En el mar eso se llama suerte; en tierra, oficio.'),
      ],
    },
  ],
};

const FELA: PassengerArc = {
  archetypeId: 'chinchorro-cook',
  premise: 'Veintidós años en la misma curva y un hijo que quiere modernizarlo todo.',
  stages: [
    {
      id: 'chinchorro-cook-1',
      title: 'La freidora nueva',
      note: 'A Doña Fela le llegó freidora nueva. Todavía no confía en ella.',
      lines: [
        L('pickup', 'Freidora nueva. La vieja se murió friendo, como debe ser.'),
        L('idle', 'La nueva tiene termostato. Yo tengo veintidós años de mano. Ya veremos quién gana.'),
        L('idle', 'El aceite se sabe por el ruido, mi amor. Ninguna maquinita te dice eso.'),
        L('idle', 'Freí las primeras sesenta ayer. Salieron bien. No se lo digas a la freidora.'),
        L('dropoff', 'Calienticas. Toma dos para el camino y no me discutas.'),
        L('perfect', 'Ni una gota fuera. Tú sirves para esto, nene, ya te lo he dicho.'),
      ],
    },
    {
      id: 'chinchorro-cook-2',
      title: 'La fila hasta la carretera',
      note: 'El hijo de Doña Fela la puso en el teléfono. Ahora la fila llega a la carretera.',
      lines: [
        L('pickup', 'Mi hijo me puso en el teléfono. Ahora viene gente de todos lados. ¡Arranca!'),
        L('idle', 'Salí en un video. Yo. Friendo. Setenta mil personas viéndome freír.'),
        L('idle', 'Vino una muchacha desde Chicago solo por las alcapurrias. Desde Chicago, mi amor.'),
        L('idle', 'La fila llega a la carretera los domingos. Me duelen los pies y estoy contentísima.'),
        L('idle', 'Mi hijo quiere que suba el precio. Le dije que no. Se calló.'),
        L('dropoff', 'Gracias. Y ponte en la fila el domingo, que a ti no te cobro.'),
        L('perfect', 'Con la bandeja entera y a tiempo. Así se trabaja.'),
      ],
    },
    {
      id: 'chinchorro-cook-3',
      title: 'El segundo chinchorro',
      note: 'Doña Fela abrió un segundo chinchorro. Lo lleva su hijo y ella lo supervisa por teléfono.',
      lines: [
        L('pickup', 'Abrimos el segundo. Lo lleva mi hijo. Yo lo llamo cada dos horas, es normal.'),
        L('idle', 'Le dije: la yautía se ralla a mano. Me habló de máquinas. Fui y le quité la máquina.'),
        L('idle', 'Veintidós años en una curva y ahora tengo dos. Mi mamá no lo hubiera creído.'),
        L('idle', 'Puse a mi nuera en la caja. Cuenta más rápido que yo y no se le pierde ni un peso.'),
        L('idle', 'Los domingos me siento una hora. Con los pies en alto y la bandeja quietecita.'),
        L('dropoff', 'Toma. Y llévale una al de la gasolinera, que siempre pregunta por ti.'),
        L('perfect', 'Llevas años sin virarme una bandeja. Eso no lo puedo decir ni de mi hijo.'),
      ],
    },
  ],
};

const SOLIS: PassengerArc = {
  archetypeId: 'nurse',
  premise: 'Turnos de doce horas y una plaza fija que nunca sale.',
  stages: [
    {
      id: 'nurse-1',
      title: 'Tres semanas de día',
      note: 'A la enfermera Solís le dieron turno de día. Duró tres semanas.',
      lines: [
        L('pickup', 'Me pusieron de día. Tres semanas duró. Otra vez de noche.'),
        L('idle', 'De día uno duerme. De noche uno existe. Es distinto y ya me acostumbré.'),
        L('idle', 'Anoche vino un nene con un brazo roto y una sonrisa. Se cayó del muro. Otro.'),
        L('idle', 'Doce horas, y después manejo yo. Y usted me dice que vaya despacio, ¿verdad?'),
        L('dropoff', 'Gracias. Entré con dos minutos. Dos.'),
        L('perfect', 'Rápido y sin un rasguño. Como debería ser todo.'),
      ],
    },
    {
      id: 'nurse-2',
      title: 'Clases a las seis',
      note: 'La enfermera Solís está estudiando anestesia. Clases a las seis de la mañana.',
      lines: [
        L('pickup', 'Salgo del turno y entro a clase. Sí, ya sé. Arranque.'),
        L('idle', 'Estoy estudiando anestesia. Clases a las seis. Duermo en pedazos.'),
        L('idle', 'Treinta y cuatro años y subrayando libros otra vez. Es ridículo y me encanta.'),
        L('idle', 'Si apruebo, la plaza es fija. Fija quiere decir alquilar sin miedo.'),
        L('idle', 'Mi mamá quería que fuera maestra. Ahora dice que siempre lo supo. Ajá.'),
        L('dropoff', 'Gracias. Con estos diez minutos me leo un capítulo entero.'),
        L('perfect', 'Perfecto. Si maneja así el jueves, me lleva al examen.'),
      ],
    },
    {
      id: 'nurse-3',
      title: 'Plaza fija',
      note: 'La enfermera Solís aprobó. Plaza fija, turno escogido, y duerme de noche.',
      lines: [
        L('pickup', 'Aprobé. Plaza fija. Y escogí turno de día, por primera vez en nueve años.'),
        L('idle', 'Dormí ocho horas seguidas el sábado. Ocho. Me desperté asustada.'),
        L('idle', 'Ahora entreno a las nuevas. Les digo lo mismo que me dijeron: come, aunque sea de pie.'),
        L('idle', 'Alquilé un sitio con ventana grande. Le da el sol por la tarde. No sabía que eso importaba.'),
        L('idle', 'Usted me llevó al examen, ¿se acuerda? Llegué con quince minutos.'),
        L('dropoff', 'Tenga. Y cuídese esa espalda, que se lo dije hace años y no me hizo caso.'),
        L('perfect', 'Impecable. Usted y yo llevamos años en horarios raros. Mírenos ahora.'),
      ],
    },
  ],
};

const MELAZA: PassengerArc = {
  archetypeId: 'dj',
  premise: 'Dos cajas de vinilo heredadas y un padre con el que no habla.',
  stages: [
    {
      id: 'dj-1',
      title: 'El cierre',
      note: 'A Melaza le dieron el set de cierre. Las cuatro de la mañana, la hora buena.',
      lines: [
        L('pickup', 'Me dieron el cierre. Las cuatro de la mañana. La hora de los que se quedan.'),
        L('idle', 'A las cuatro la gente ya no busca nada. Solo baila. Ahí es que uno pincha de verdad.'),
        L('idle', 'Voy a abrir con salsa dura. Nadie abre un cierre con salsa dura. Yo sí.'),
        L('idle', 'Estos vinilos eran de mi papá. Se los cogí en el noventa y ocho y nunca los devolví.'),
        L('dropoff', 'Llegamos. Quédate hasta las cuatro y me entiendes.'),
        L('perfect', 'Sin un salto en las cajas. Respeto, mano.'),
      ],
    },
    {
      id: 'dj-2',
      title: 'La servilleta',
      note: 'El papá de Melaza apareció en el kiosko. Once años sin hablarse.',
      lines: [
        L('pickup', 'Mi papá apareció el sábado. En el kiosko. Once años sin hablarnos.'),
        L('idle', 'Se quedó parado atrás. No me saludó. Se quedó dos horas.'),
        L('idle', 'Puse un disco suyo. El de la portada azul. Lo puse a propósito.'),
        L('idle', 'Cuando terminé ya no estaba. Dejó una servilleta con un número. El de siempre.'),
        L('idle', 'No lo he llamado. Lo voy a llamar. Un día de estos.'),
        L('dropoff', 'Gracias, pana. Hoy la música es lo único que sé hacer bien.'),
        L('perfect', 'Eso estuvo limpio. Hoy lo necesitaba limpio.'),
      ],
    },
    {
      id: 'dj-3',
      title: 'Los domingos',
      note: 'Melaza pincha con su papá los domingos. El viejo trae los discos y no dice nada.',
      lines: [
        L('pickup', 'Los domingos pincho con el viejo. Él trae los discos, yo pongo las manos.'),
        L('idle', 'No hablamos mucho. Nos pasamos discos. Es como hablar, pero sin equivocarse.'),
        L('idle', 'Me enseñó a mezclar dos temas que yo llevaba diez años haciendo mal.'),
        L('idle', 'La gente cree que somos hermanos. Se lo dejo. Le gusta.'),
        L('idle', 'Le devolví los vinilos. Me los devolvió. Ahora son de los dos.'),
        L('dropoff', 'El domingo a las seis. Trae hambre, que mi mamá cocina y nadie se va temprano.'),
        L('perfect', 'Un set completo sin un salto. Eso me lo enseñó él, y ahora te lo digo yo.'),
      ],
    },
  ],
};

const CUQUI: PassengerArc = {
  archetypeId: 'party-host',
  premise: 'Organiza a todo el mundo menos a sí misma.',
  stages: [
    {
      id: 'party-host-1',
      title: 'Sesenta personas',
      note: 'La Cuqui está montando un chinchorreo de sesenta personas. Ella sola.',
      lines: [
        L('pickup', 'Somos sesenta. Sesenta, nene. Y todos me escriben a mí.'),
        L('idle', 'Tengo tres listas: los que vienen, los que dicen que vienen, y los que no van a venir.'),
        L('idle', 'La tercera lista es la más larga y aun así hay que contarlos.'),
        L('idle', 'Yo no me divierto en mis fiestas. Me divierto el martes, contándolas.'),
        L('dropoff', 'Llegamos. Quédate, en serio. Aunque sea una hora.'),
        L('perfect', 'Tú eres el único que llega cuando dice. El único.'),
      ],
    },
    {
      id: 'party-host-2',
      title: 'Las fiestas del barrio',
      note: 'A La Cuqui le pidieron organizar las fiestas del barrio. Pagan poco y agradecen mucho.',
      lines: [
        L('pickup', 'Me pidieron las fiestas del barrio. Las de verdad, con permisos y todo.'),
        L('idle', 'Pagan poquísimo. Pero es el barrio, así que dije que sí antes de preguntar.'),
        L('idle', 'Tarima, sonido, baños y permiso de la ciudad. Cuatro cosas. Llevo dos meses.'),
        L('idle', 'Mi mamá me dijo que estoy loca. Después preguntó a qué hora empieza.'),
        L('idle', 'Si sale bien se hace todos los años. Si sale mal, me mudo.'),
        L('dropoff', 'Toma. Y apúntate el sábado, que te necesito moviendo gente.'),
        L('perfect', 'Contigo no me tengo que preocupar. ¿Tú sabes lo raro que es eso en mi vida?'),
      ],
    },
    {
      id: 'party-host-3',
      title: 'Dos mil personas',
      note: 'Las fiestas de La Cuqui salieron. Dos mil personas y no se peleó nadie.',
      lines: [
        L('pickup', 'Dos mil personas, nene. Dos mil. Y no se peleó nadie.'),
        L('idle', 'Lloré a las once de la noche detrás de la tarima. Solo me vio Don Chelo.'),
        L('idle', 'Me dieron una placa. Una placa de verdad, con mi nombre mal escrito.'),
        L('idle', 'Ahora me llaman de otros barrios. Estoy aprendiendo a decir que no. Voy lento.'),
        L('idle', 'El año que viene quiero tarima doble. Ya empecé la lista.'),
        L('dropoff', 'Toma. Y el año que viene tú abres la caravana. Ya lo dije en el grupo.'),
        L('perfect', 'Tú me has llevado a todo. A todo. Eso también cuenta, aunque no esté en la placa.'),
      ],
    },
  ],
};

const CHELO: PassengerArc = {
  archetypeId: 'abuelo-parrandero',
  premise: 'Setenta y cuatro años, un güiro, y una casa que suena grande desde marzo.',
  stages: [
    {
      id: 'abuelo-parrandero-1',
      title: 'Los nietos',
      note: 'Don Chelo está enseñando a raspar el güiro a sus nietos. Dos de tres tienen mano.',
      lines: [
        L('pickup', 'Voy a casa de mi hija. Los nietos quieren aprender el güiro.'),
        L('idle', 'Tres nietos. Dos tienen mano. El tercero tiene entusiasmo, que también sirve.'),
        L('idle', 'La púa se agarra suave. El que aprieta, raspa feo. Ese es todo el secreto.'),
        L('idle', 'Mi papá me enseñó a los siete años con una lata de galletas.'),
        L('dropoff', 'Llegamos. Si oyes ruido raro esta noche, somos nosotros ensayando.'),
        L('perfect', 'Manejas con respeto. Eso hoy no se ve.'),
      ],
    },
    {
      id: 'abuelo-parrandero-2',
      title: 'La casa sin la Nena',
      note: 'A Don Chelo se le fue la Nena en marzo. Sigue saliendo, pero llega más temprano.',
      lines: [
        L('pickup', 'Vamos suave hoy, mijo. No tengo prisa.'),
        L('idle', 'Mi Nena se fue en marzo. Cincuenta y un años juntos.'),
        L('idle', 'La casa suena distinto. Uno no sabe que una persona hace ruido hasta que no lo hace.'),
        L('idle', 'Salgo igual. Ella me hubiera dado un cocotazo si me quedo sentado.'),
        L('idle', 'Cuando toco el güiro no pienso. Por eso toco tanto.'),
        L('dropoff', 'Gracias, mijo. Déjame en la esquina, que quiero caminar un pedacito.'),
        L('perfect', 'Suave y derecho. Hoy eso se agradece más de lo normal.'),
      ],
    },
    {
      id: 'abuelo-parrandero-3',
      title: 'Los jueves',
      note: 'Don Chelo montó parranda con los vecinos. Salen los jueves y no avisan a nadie.',
      lines: [
        L('pickup', 'Los jueves salimos. Seis viejos y un güiro cada uno. No avisamos, llegamos.'),
        L('idle', 'Empezamos tres. Ya somos seis. La semana que viene siete, hay uno pensándolo.'),
        L('idle', 'Tocamos frente a las casas de la gente que vive sola. Ellos no lo piden y nosotros no preguntamos.'),
        L('idle', 'A mi Nena le hubiera encantado. Le hubiera puesto nombre y horario.'),
        L('idle', 'Setenta y cuatro años y tengo agenda. Agenda, mijo.'),
        L('dropoff', 'Toma. Y el jueves, si estás libre, tú nos llevas. Cabemos apretados y cantamos peor.'),
        L('perfect', 'Manejas como se bailaba antes: con respeto y con gusto. Ya te lo dije, y lo repito.'),
      ],
    },
  ],
};

const WISO: PassengerArc = {
  archetypeId: 'tio-wiso',
  premise: 'Treinta y un años manejando esta ruta y una cadera nueva que todavía no perdona.',
  stages: [
    {
      id: 'tio-wiso-1',
      title: 'Hasta la esquina',
      note: 'Tío Wiso caminó hasta la esquina sin bastón. Volvió con bastón, pero fue.',
      lines: [
        L('pickup', 'Hoy caminé hasta la esquina. Sin el palo. Volví con él, pero fui.'),
        L('idle', 'La terapista tiene veintiséis años y no me tiene miedo. Eso me gusta.'),
        L('idle', 'Duele. Pero duele distinto que antes. Duele para adelante.'),
        L('idle', 'Yo pensaba que lo peor iba a ser la operación. Lo peor es estar sentado.'),
        L('idle', 'Nelo me puso una silla en el taller. Con sombra y todo. Ahí dirijo el tráfico.'),
        L('dropoff', 'Bien ahí, mijo. Mañana camino dos esquinas. Ya verás.'),
        L('perfect', 'Ni un frenazo. Ese carro te está cogiendo cariño, y eso no se finge.'),
      ],
    },
    {
      id: 'tio-wiso-2',
      title: 'El letrero',
      note: 'Tío Wiso está repintando el letrero de Transporte Wiso. A mano, como siempre.',
      lines: [
        L('pickup', 'Estoy repintando el letrero. A mano. Como se hace.'),
        L('idle', 'La "W" es la difícil. Siempre fue la difícil. Cuarenta años y todavía.'),
        L('idle', 'Ese letrero lo colgué yo en el ochenta y tres. Con dos clavos y un tornillo malo.'),
        L('idle', 'Tu abuela decía que el nombre estaba mal puesto. Que sonaba a mudanza.'),
        L('idle', 'Yaniel me ofreció pintarlo. Le dije que no. Esta vez lo hago yo. La próxima, él.'),
        L('idle', 'Cuando lo vuelva a colgar, lo cuelgas tú. Yo miro. Es parte del trato.'),
        L('dropoff', 'Toma. Y no discutas, que el que maneja cobra. Regla número uno.'),
        L('perfect', 'Eso. Mira eso. Yo manejaba así a los cuarenta, y me costó llegar.'),
      ],
    },
    {
      id: 'tio-wiso-3',
      title: 'De pasajero',
      note: 'Tío Wiso se volvió a montar. De pasajero, protestando, pero se montó.',
      lines: [
        L('pickup', 'Dale. Y llévame por la muralla, que hace un año que no la veo de cerca.'),
        L('idle', 'Yo pensaba que iba a extrañar manejar. Extraño la gente. Es distinto.'),
        L('idle', 'Doña Carmen preguntó por mí. Dile que sigo vivo y que le debo dos pesos.'),
        L('idle', 'Este carro tiene más años que tú y le queda más cuerda que a mí.'),
        L('idle', 'Yo no te dejé un negocio, mijo. Te dejé una lista de gente. Cuídala.'),
        L('idle', 'Cuando yo empecé, esta ciudad no me conocía. Mírate tú ahora.'),
        L('almostThere', 'Despacio en esta parte. Déjame mirarlo bien.', 24),
        L('dropoff', 'Ya está. Ya se puede decir que esto es tuyo. Yo lo digo y yo sé.'),
        L('perfect', 'Perfecto. Y no lo digo por ser tu tío. Lo digo porque llevo treinta y un años calificando.'),
      ],
    },
  ],
};

const NELO: PassengerArc = {
  archetypeId: 'mecanico',
  premise: 'Un taller heredado, una van que no arranca, y una libreta de favores que nadie cobra.',
  stages: [
    {
      id: 'mecanico-1',
      title: 'La pieza',
      note: 'Nelo consiguió la pieza. Le tomó cinco semanas y tres favores.',
      lines: [
        L('pickup', 'Conseguí la pieza. Cinco semanas y tres favores, pero la conseguí.'),
        L('idle', 'Vino de un desguace de allá abajo. El tipo no me cobró, me pidió que le mirara una guagua.'),
        L('idle', 'Así funciona esto. Nadie tiene, pero entre todos siempre aparece.'),
        L('idle', 'Le voy a limpiar los inyectores este fin de semana. Va a sonar distinto, ya verás.'),
        L('dropoff', 'Ya está. El sábado te la enseño montada, para que veas lo que es una pieza buena.'),
        L('perfect', 'Suave con los cambios y rápido igual. Eso es manejar con cabeza.'),
      ],
    },
    {
      id: 'mecanico-2',
      title: 'Arrancó',
      note: 'Nelo prendió la van. Sonó a la primera y no se lo esperaba nadie.',
      lines: [
        L('pickup', 'Arrancó. A la primera. Yo estaba solo y grité como un nene.'),
        L('idle', 'Siete meses con esa van. Siete. Mi papá la compró en el ochenta y siete.'),
        L('idle', 'Le puse el motor que quedó del compadre de Don Nino. Todo aquí se recicla, hasta la suerte.'),
        L('idle', 'Ahora tengo que decidir si la vendo o la uso. Ya sé lo que voy a hacer.'),
        L('idle', 'Wiso vino a verla. Se quedó parado media hora sin decir nada. Eso es un elogio.'),
        L('dropoff', 'Gracias, pana. Cuando la saque a rodar, tú vas de copiloto.'),
        L('perfect', 'Impecable. Con las manos que tú tienes deberías arreglar carros y no romperlos.'),
      ],
    },
    {
      id: 'mecanico-3',
      title: 'Los sábados',
      note: 'Nelo abre el taller los sábados para enseñar. Van cuatro muchachas y dos muchachos.',
      lines: [
        L('pickup', 'Los sábados abro para enseñar. Cuatro muchachas y dos muchachos. Gratis.'),
        L('idle', 'Una de ellas cambia un alternador más rápido que yo. Tiene diecisiete años.'),
        L('idle', 'Yo aprendí mirando a mi papá y a mi tío. Nadie me explicó nada. Así no.'),
        L('idle', 'Les cobro una cosa: que después le enseñen a otro. Firmado en la libreta.'),
        L('idle', 'El taller se llama "Los Hermanos" y por fin vuelve a haber más de uno.'),
        L('dropoff', 'Pásate el sábado. Te pongo a apretar tuercas, no creas que vienes de visita.'),
        L('perfect', 'Tú cuidas ese carro y ese carro te cuida a ti. Es un trato justo.'),
      ],
    },
  ],
};

/* ---------------------------------------------------------------- lookup */

const ALL: readonly PassengerArc[] = [
  KIQUE,
  YOLANDA,
  MARLA,
  CARMEN,
  YANIEL,
  TATO,
  IRIS,
  BRYAN,
  MILLIE,
  KBO,
  NINO,
  FELA,
  SOLIS,
  MELAZA,
  CUQUI,
  CHELO,
  WISO,
  NELO,
];

export const ARCS: Readonly<Record<string, PassengerArc>> = (() => {
  const out: Record<string, PassengerArc> = {};
  for (const arc of ALL) out[arc.archetypeId] = arc;
  return out;
})();

export const ARC_IDS: readonly string[] = ALL.map((a) => a.archetypeId);

/** How many stages this person has beyond their base bank. */
export function arcStageCount(archetypeId: string): number {
  return ARCS[archetypeId]?.stages.length ?? 0;
}

/**
 * Which stage `rides` completed rides puts you in. 0 = the base bank, 1..n =
 * an arc stage. Never returns past the stages that actually exist.
 */
export function arcStageIndex(archetypeId: string, rides: number): number {
  const arc = ARCS[archetypeId];
  if (!arc) return 0;
  const n = Number.isFinite(rides) ? Math.max(0, Math.floor(rides)) : 0;
  let stage = 0;
  for (let i = 0; i < ARC_THRESHOLDS.length && i < arc.stages.length; i++) {
    if (n >= ARC_THRESHOLDS[i]) stage = i + 1;
  }
  return stage;
}

/** The stage definition for a 1-based stage number, or null for the base bank. */
export function arcStageAt(archetypeId: string, stage: number): ArcStage | null {
  const arc = ARCS[archetypeId];
  if (!arc || stage <= 0) return null;
  return arc.stages[stage - 1] ?? null;
}

/** Lines layered over the base bank at this stage; empty for the base bank. */
export function arcLines(archetypeId: string, stage: number): readonly DialogueLine[] {
  return arcStageAt(archetypeId, stage)?.lines ?? EMPTY_LINES;
}

const EMPTY_LINES: readonly DialogueLine[] = [];

/** Total authored arc lines — the harness asserts the bank stayed big. */
export function arcLineCount(): number {
  let n = 0;
  for (const arc of ALL) for (const s of arc.stages) n += s.lines.length;
  return n;
}
