#!/usr/bin/perl
# Process-group supervisor used by codex-run.sh (规划/11 §2.4 "超时", §2.2 "看门狗").
#
# Runs one command in its OWN process group and never signals a single process:
#   - hard timeout (SIGALRM) and inactivity watchdog both end with TERM to the whole group,
#     --grace-secs of waiting, then KILL to the whole group;
#   - inactivity means: the --idle-file has not been modified AND the processes of the run have
#     not consumed CPU for --idle-secs (规划/11 §2.2: 活性看文件修改时间或进程 CPU). A command
#     that runs for minutes without printing an event (pnpm test inside the sandbox) stays alive
#     as long as it works;
#   - TERM/INT/HUP sent to this supervisor are forwarded to the group the same way, so
#     stopping the wrapper never leaves a Codex process running;
#   - once a second the process table is scanned and every descendant of the leader is
#     remembered, including descendants that left the group (setsid). They are ended together
#     with the group, and the status reports how many had escaped and how many are left;
#   - after the command exits (or is killed) it polls until no process of the group is alive
#     and only then returns, so the caller may read the `-o` file.
#
# Exit code: 124 on timeout or inactivity kill, otherwise the exit code of the command
# (128+signal when it died from a signal, 127 when exec failed). Usage errors exit 2.
# Details are written to --status-file as key=value lines.
use strict;
use warnings;
use POSIX qw(:sys_wait_h :errno_h);
use Fcntl qw(F_GETFD F_SETFD FD_CLOEXEC);

my $HIRES = eval { require Time::HiRes; 1 } ? 1 : 0;
sub now { return $HIRES ? Time::HiRes::time() : time(); }
sub nap { select( undef, undef, undef, $_[0] ); return; }

sub usage {
    print STDERR "usage: supervise.pl --timeout-secs <n> [--grace-secs <n>] "
      . "[--idle-secs <n> --idle-file <file>] [--stdout <file>] [--stderr <file>] "
      . "[--status-file <file>] [--pgid-file <file>] -- <command> [args...]\n";
    exit 2;
}

my %opt = ( 'timeout-secs' => undef, 'grace-secs' => 5, 'idle-secs' => 0 );
my %known = map { $_ => 1 }
  qw(timeout-secs grace-secs idle-secs idle-file stdout stderr status-file pgid-file);
my $saw_separator = 0;
while (@ARGV) {
    my $arg = shift @ARGV;
    if ( $arg eq '--' ) { $saw_separator = 1; last; }
    usage() unless $arg =~ /^--(.+)$/ && $known{$1} && @ARGV;
    $opt{$1} = shift @ARGV;
}
my @cmd = @ARGV;
usage() unless $saw_separator && @cmd;
for my $key (qw(timeout-secs grace-secs idle-secs)) {
    usage() unless defined $opt{$key} && $opt{$key} =~ /^\d+$/;
}
usage() unless $opt{'timeout-secs'} > 0;
usage() if $opt{'idle-secs'} > 0 && !defined $opt{'idle-file'};

my ( $timeout, $grace, $idle ) = @opt{qw(timeout-secs grace-secs idle-secs)};

# CPU time counts as activity only when it grows by this much since the last mark (5% of the
# idle window, at least a quarter second): a process that merely polls (a `sleep` loop) stays
# below it, a test run is far above it.
my $CPU_STEP = $idle > 0 ? ( 0.05 * $idle > 0.25 ? 0.05 * $idle : 0.25 ) : 0.25;

# Process-table scans: once a second, or more often for a short idle window (Linux reports
# cputime in whole seconds, so a scan must land inside the window after the counter moved).
my $SCAN_EVERY = ( $idle > 0 && $idle / 5 < 1.0 ) ? $idle / 5 : 1.0;

# Every process started below the leader inherits an open descriptor on this marker file; it
# finds descendants again after they left the group and were reparented to init, where the
# ancestry scan can no longer see them (Linux: /proc/*/fd, macOS: lsof). Environment markers
# are useless on macOS, whose `ps -E` shows no environment.
my $MARKER_FILE = ( defined $opt{'status-file'} ? $opt{'status-file'} : "/tmp/couli-supervise.$$" ) . ".marker";
open( my $MARKER_FH, '>', $MARKER_FILE ) or die "supervise.pl: cannot create $MARKER_FILE: $!\n";
{
    my $flags = fcntl( $MARKER_FH, F_GETFD, 0 );
    fcntl( $MARKER_FH, F_SETFD, $flags & ~FD_CLOEXEC ) if defined $flags;
}
my $MARKER_REAL = $MARKER_FILE;
if ( eval { require Cwd; 1 } ) { $MARKER_REAL = Cwd::realpath($MARKER_FILE) // $MARKER_FILE; }

sub write_file_atomic {
    my ( $file, $text ) = @_;
    my $tmp = "$file.tmp.$$";
    open( my $fh, '>', $tmp ) or return;
    print {$fh} $text;
    close($fh);
    rename( $tmp, $file );
    return;
}

my $started = now();
my $pid     = fork();
if ( !defined $pid ) {
    print STDERR "supervise.pl: fork failed: $!\n";
    exit 2;
}
if ( $pid == 0 ) {

    # Child: become the leader of a new process group, close stdin, redirect output, exec.
    setpgrp( 0, 0 );
    open( STDIN, '<', '/dev/null' ) or POSIX::_exit(126);
    if ( defined $opt{stdout} ) { open( STDOUT, '>', $opt{stdout} ) or POSIX::_exit(126); }
    if ( defined $opt{stderr} ) { open( STDERR, '>', $opt{stderr} ) or POSIX::_exit(126); }
    { no warnings 'exec'; exec { $cmd[0] } @cmd; }
    POSIX::_exit(127);
}

# Parent: set the group as well so a kill issued before the child ran setpgrp still targets
# the right group (fails harmlessly with EACCES once the child has exec'ed).
POSIX::setpgid( $pid, $pid );
write_file_atomic( $opt{'pgid-file'}, "$pid\n" ) if defined $opt{'pgid-file'};

my ( $alarm_fired, $abort_signal ) = ( 0, '' );
local $SIG{ALRM} = sub { $alarm_fired = 1; };
local $SIG{TERM} = sub { $abort_signal ||= 'TERM'; };
local $SIG{INT}  = sub { $abort_signal ||= 'INT'; };
local $SIG{HUP}  = sub { $abort_signal ||= 'HUP'; };
alarm($timeout);

my ( $reaped, $status ) = ( 0, 0 );

sub reap {
    return 1 if $reaped;
    my $r = waitpid( $pid, WNOHANG );
    if ( $r == $pid ) { $status = $?; $reaped = 1; }
    elsif ( $r == -1 ) { $status = 255 << 8; $reaped = 1; }    # cannot happen: we are the parent
    return $reaped;
}

# True while any process of the group exists (the reaped leader does not count).
sub group_alive {
    return 1 if kill( 0, -$pid );
    return $! == EPERM ? 1 : 0;
}

sub pid_alive {
    my ($p) = @_;
    return 1 if kill( 0, $p );
    return $! == EPERM ? 1 : 0;
}

# ---------------------------------------------------------------------------------------------
# Process-table scan: descendants of the leader (by ppid, transitively, plus every member of
# the group) and their accumulated CPU time. `ps` is portable between macOS and Linux for the
# four columns used here; cputime is `[[dd-]hh:]mm:ss[.cc]` on both.
# ---------------------------------------------------------------------------------------------
my %descendant;    # pid => ppid at discovery
my %cpu_seen;      # pid => highest cputime seen (a process that exits keeps its contribution)
my $cpu_mark      = 0;           # cpu total at the last activity mark
my $cpu_active_at = $started;    # when CPU activity was last observed
my $next_scan     = $started;

sub cpu_secs {
    my ($text) = @_;
    my $days = 0;
    if ( $text =~ s/^(\d+)-// ) { $days = $1; }
    my $secs = 0;
    for my $part ( split /:/, $text ) {
        return 0 unless $part =~ /^\d+(?:\.\d+)?$/;
        $secs = $secs * 60 + $part;
    }
    return $days * 86400 + $secs;
}

sub scan_processes {
    my @rows;
    open( my $ph, '-|', 'ps', '-axo', 'pid=,ppid=,pgid=,cputime=' ) or return;
    while ( my $line = <$ph> ) {
        my ( $p, $pp, $pg, $t ) = split ' ', $line;
        next unless defined $t && $p =~ /^\d+$/ && $pp =~ /^\d+$/ && $pg =~ /^-?\d+$/;
        push @rows, [ $p, $pp, $pg, cpu_secs($t) ];
    }
    close($ph);
    return unless @rows;

    my %found = ( $pid => 1 );
    my @queue = ($pid);
    while (@queue) {
        my $cur = shift @queue;
        for my $row (@rows) {
            next if $found{ $row->[0] } || $row->[1] != $cur;
            $found{ $row->[0] } = 1;
            push @queue, $row->[0];
        }
    }
    for my $row (@rows) {
        my ( $p, $pp, $pg, $cpu ) = @{$row};
        $found{$p} = 1 if $pg == $pid;
        next unless $found{$p};
        $descendant{$p} = $pp unless exists $descendant{$p};
        $cpu_seen{$p} = $cpu if !defined $cpu_seen{$p} || $cpu > $cpu_seen{$p};
    }
    # Only CPU counts (a poll loop spawning `sleep` every 100 ms is not activity).
    my $total = 0;
    $total += $_ for values %cpu_seen;
    if ( $total - $cpu_mark >= $CPU_STEP ) {
        $cpu_mark      = $total;
        $cpu_active_at = now();
    }
    return;
}

sub maybe_scan {
    return if now() < $next_scan;
    $next_scan = now() + $SCAN_EVERY;
    scan_processes();
    return;
}

# Processes that still hold the inherited marker descriptor: /proc on Linux, lsof on macOS.
sub marker_pids {
    my %out;
    if ( -d '/proc' && opendir( my $dh, '/proc' ) ) {
        for my $entry ( readdir($dh) ) {
            next unless $entry =~ /^\d+$/ && $entry != $$ && $entry != $pid;
            opendir( my $fdh, "/proc/$entry/fd" ) or next;
            for my $fd ( readdir($fdh) ) {
                next unless $fd =~ /^\d+$/;
                my $target = readlink("/proc/$entry/fd/$fd");
                next unless defined $target;
                if ( $target eq $MARKER_REAL || $target eq $MARKER_FILE ) { $out{$entry} = 1; last; }
            }
            closedir($fdh);
        }
        closedir($dh);
        return keys %out;
    }
    my $lsof = -x '/usr/sbin/lsof' ? '/usr/sbin/lsof' : 'lsof';
    if ( open( my $ph, '-|', $lsof, '-t', '--', $MARKER_FILE ) ) {
        while ( my $line = <$ph> ) {
            next unless $line =~ /^\s*(\d+)\s*$/;
            my $p = $1;
            next if $p == $$ || $p == $pid;
            $out{$p} = 1;
        }
        close($ph);
    }
    return keys %out;
}

# Descendants that are alive outside the group (escaped with setsid, or already reparented to
# init): remembered by the ancestry scan, or found again through the environment marker. A
# remembered pid is only trusted when its parent is still the one recorded, or init, so a
# recycled pid is not signalled.
sub escaped_alive {
    my %out;
    my %parent;
    if ( open( my $ph, '-|', 'ps', '-axo', 'pid=,ppid=,pgid=' ) ) {
        while ( my $line = <$ph> ) {
            my ( $p, $pp, $pg ) = split ' ', $line;
            next unless defined $pg;
            $parent{$p} = [ $pp, $pg ];
        }
        close($ph);
    }
    for my $p ( keys %descendant ) {
        next if $p == $pid;
        my $info = $parent{$p} or next;
        my ( $pp, $pg ) = @{$info};
        next if $pg == $pid;    # still in the group: the group kill covers it
        next unless $pp == $descendant{$p} || $pp == 1;
        $out{$p} = 1;
    }
    for my $p ( marker_pids() ) {
        my $info = $parent{$p} or next;
        next if $info->[1] == $pid;
        $out{$p} = 1;
    }
    return sort { $a <=> $b } keys %out;
}

sub kill_escaped {
    my @victims = escaped_alive();
    return 0 unless @victims;
    kill( 'TERM', @victims );
    my $deadline = now() + $grace;
    while ( now() < $deadline ) {
        last unless grep { pid_alive($_) } @victims;
        nap(0.05);
    }
    my @left = grep { pid_alive($_) } @victims;
    kill( 'KILL', @left ) if @left;
    return scalar @victims;
}

sub kill_group {
    kill( 'TERM', -$pid );
    my $deadline = now() + $grace;
    while ( now() < $deadline ) {
        reap();
        last if $reaped && !group_alive();
        nap(0.05);
    }

    # Nothing left: do not signal a group id that no longer belongs to this run.
    kill( 'KILL', -$pid ) if !$reaped || group_alive();
    return;
}


my ( $timed_out, $idle_killed, $stragglers_killed, $escaped_killed ) = ( 0, 0, 0, 0 );

sub idle_exceeded {
    return 0 unless $idle > 0;
    my @st   = stat( $opt{'idle-file'} );
    my $file = ( @st && $st[9] > $started ) ? $st[9] : $started;
    my $last = $file > $cpu_active_at ? $file : $cpu_active_at;
    return ( now() - $last ) >= $idle ? 1 : 0;
}

while ( !reap() ) {
    maybe_scan();
    if ($alarm_fired)      { $timed_out   = 1; kill_group(); last; }
    if ($abort_signal)     { kill_group(); last; }
    if ( idle_exceeded() ) { $idle_killed = 1; kill_group(); last; }
    nap(0.1);
}
alarm(0);

# After KILL the leader goes away promptly; poll instead of blocking so a second signal to this
# supervisor cannot leave it stuck.
my $reap_deadline = now() + 30;
while ( !reap() && now() < $reap_deadline ) { nap(0.05); }

# One last look at the table: descendants that appeared since the previous scan.
scan_processes();

# Leader exited by itself but left processes behind in its group: give them the grace period,
# then remove them. Nothing of this group may still run when the caller reads the output.
if ( $reaped && !$timed_out && !$idle_killed && !$abort_signal && group_alive() ) {
    my $deadline = now() + $grace;
    while ( now() < $deadline && group_alive() ) { nap(0.05); }
    if ( group_alive() ) { $stragglers_killed = 1; kill_group(); }
}

my $gone_deadline = now() + 30;
while ( group_alive() && now() < $gone_deadline ) { nap(0.05); }
my $group_gone = ( $reaped && !group_alive() ) ? 1 : 0;

# Descendants that left the group are ended as well; the status says how many there were.
$escaped_killed = kill_escaped();
my $descendants_left = scalar( grep { pid_alive($_) } escaped_alive() );
close($MARKER_FH);
unlink($MARKER_FILE);

my $signal    = $reaped ? ( $status & 127 ) : 0;
my $exit_code = !$reaped ? 255 : $signal ? 128 + $signal : ( $status >> 8 );
my $elapsed   = int( now() - $started + 0.5 );

if ( defined $opt{'status-file'} ) {
    write_file_atomic(
        $opt{'status-file'},
        join( '',
            "pgid=$pid\n",                 "exit_code=$exit_code\n",
            "signal=$signal\n",            "timed_out=$timed_out\n",
            "idle_killed=$idle_killed\n",  "aborted=$abort_signal\n",
            "stragglers_killed=$stragglers_killed\n",
            "escaped_killed=$escaped_killed\n",
            "descendants_left=$descendants_left\n",
            "group_gone=$group_gone\n",    "elapsed_secs=$elapsed\n" )
    );
}

exit 124 if $timed_out || $idle_killed;
exit $exit_code;
